-- schema v23: session fork lineage (#172 Phase 2).
-- Records the DB session id a fork was created from (session/fork, UNSTABLE).
-- Empty = not a fork (normal session) or pre-migration session. This phase only
-- persists the lineage (no UI marking); the forked session shares the source's
-- worktree (same-cwd fork, iron rule ②), so worktree refs stay as-is.
ALTER TABLE sessions ADD COLUMN forked_from TEXT NOT NULL DEFAULT '';
