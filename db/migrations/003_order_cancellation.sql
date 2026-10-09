ALTER TABLE orders ADD COLUMN cancelled_at TIMESTAMPTZ;
ALTER TABLE orders ADD CONSTRAINT orders_cancellation_consistent
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));
