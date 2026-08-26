-- schema v19: recurring queue items (#111, Task #24333). A queue item can
-- now REPEAT: after each successful drain-send the item is not consumed but
-- re-armed at max(now, prev_scheduled_at + repeat_every_ms) — skip-catch-up,
-- so downtime never back-fills missed periods (one send, then re-anchored).
--   repeat_every_ms: recurrence interval, 0 = normal one-shot item (default).
--                    Bound to 1min..24h by the chat service (SetQueueItemRepeat
--                    hard-validates; the column itself is unconstrained so the
--                    bound can evolve without a migration).
--   sent_count:      successful repeat sends so far (badge "sent N"; also the
--                    max_sends odometer). NOT incremented on failed sends
--                    (busy-race requeue keeps the previous count).
--   max_sends:      0 = repeat forever (default); N = auto-clear the repeat
--                   (item turns back into a normal one-shot and is consumed)
--                   once sent_count reaches N.
ALTER TABLE queue_items ADD COLUMN repeat_every_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queue_items ADD COLUMN sent_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queue_items ADD COLUMN max_sends INTEGER NOT NULL DEFAULT 0;
