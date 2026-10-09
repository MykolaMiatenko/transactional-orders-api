CREATE TABLE outbox_events (
    sequence BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE,
    aggregate_id UUID NOT NULL REFERENCES orders(id),
    event_type TEXT NOT NULL CHECK (event_type IN ('OrderCreated', 'OrderCancelled')),
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'published', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_until TIMESTAMPTZ,
    lock_token UUID,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    CHECK ((status = 'processing') = (locked_until IS NOT NULL AND lock_token IS NOT NULL)),
    CHECK ((status = 'published') = (published_at IS NOT NULL))
);
CREATE INDEX outbox_available_idx ON outbox_events (available_at, sequence) WHERE status IN ('pending', 'processing');
CREATE INDEX outbox_aggregate_sequence_idx ON outbox_events (aggregate_id, sequence) WHERE status <> 'published';

CREATE TABLE consumed_events (
    consumer_name TEXT NOT NULL,
    event_id UUID NOT NULL,
    consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer_name, event_id)
);

-- A demo read model makes the consumer's idempotent business effect observable.
CREATE TABLE order_projections (
    order_id UUID PRIMARY KEY,
    product_id UUID NOT NULL,
    quantity INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('created', 'cancelled')),
    applied_events INTEGER NOT NULL DEFAULT 1
);

-- Backfill existing orders so cancelling a pre-outbox order has a creation event to consume first.
WITH historical AS MATERIALIZED (SELECT gen_random_uuid() AS event_id, orders.* FROM orders)
INSERT INTO outbox_events (event_id, aggregate_id, event_type, payload)
SELECT event_id, id, 'OrderCreated', jsonb_build_object(
    'eventId', event_id, 'version', 1, 'type', 'OrderCreated',
    'occurredAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'data', jsonb_build_object('orderId', id, 'productId', product_id, 'quantity', quantity, 'totalCents', total_cents)
) FROM historical ORDER BY created_at, id;

WITH historical AS MATERIALIZED (SELECT gen_random_uuid() AS event_id, orders.* FROM orders WHERE status = 'cancelled')
INSERT INTO outbox_events (event_id, aggregate_id, event_type, payload)
SELECT event_id, id, 'OrderCancelled', jsonb_build_object(
    'eventId', event_id, 'version', 1, 'type', 'OrderCancelled',
    'occurredAt', to_char(cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'data', jsonb_build_object('orderId', id, 'productId', product_id, 'quantity', quantity, 'totalCents', total_cents)
) FROM historical ORDER BY cancelled_at, id;
