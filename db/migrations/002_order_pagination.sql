ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'cancelled'));

DROP INDEX orders_user_created_idx;
CREATE INDEX orders_user_created_idx ON orders (user_id, created_at DESC, id DESC);
CREATE INDEX orders_user_status_created_idx ON orders (user_id, status, created_at DESC, id DESC);
