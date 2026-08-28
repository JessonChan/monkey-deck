-- Global-allow rule generalization (#143): read rules created by "allow globally" used to
-- pin the first location's absolute path. Rewrite them to the basename so the engine's
-- "/"-free pattern branch matches same-named files in any directory (reads are
-- side-effect free; write/exec keep their exact semantics and are NOT touched here).
--
-- Scope: level=allow AND action_type='read' AND command_pattern='' (exec rules carry a
-- command pattern; never rewrite those) AND path_pattern contains a '/' that is not the
-- trailing character (a trailing '/' would yield an empty basename = wildcard).
--
-- Basename in plain SQLite: rtrim(p, replace(p, '/', '')) strips every trailing character
-- that is not '/', leaving everything up to and including the last '/'; substr from
-- length(...) + 1 yields the basename. For a path without '/', rtrim returns '' and the
-- pattern is kept as-is (guarded by the WHERE clause anyway).
--
-- Glob patterns (containing * ? [) are excluded: they are user-authored rules, not
-- global-allow artifacts, and rewriting them to a basename would silently broaden them.
--
-- Idempotent: a rewritten pattern contains no '/', so the WHERE clause no longer matches
-- and re-running is a no-op.
UPDATE permission_rules
SET path_pattern = substr(
        path_pattern,
        length(rtrim(path_pattern, replace(path_pattern, '/', ''))) + 1
    ),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE level = 'allow'
  AND action_type = 'read'
  AND command_pattern = ''
  AND path_pattern LIKE '%/%'
  AND path_pattern NOT LIKE '%/'
  AND path_pattern NOT LIKE '%*%'
  AND path_pattern NOT LIKE '%?%'
  AND path_pattern NOT LIKE '%[%';
