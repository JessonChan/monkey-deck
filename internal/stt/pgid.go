// pgid.go: sidecar process-group registry persisted across runs (§3.2 orphan
// discipline, same idea as the harness layer's pgidFile in internal/acp).
//
// Problem (#24308 review P2): SIGKILLing the host app (or a hard crash)
// leaves the whisper-server sidecar orphaned — a large model can pin ~1.5 GB
// until manually killed. stop() cannot run in that scenario, so the pgid is
// persisted to disk at spawn time and the NEXT run's ServiceStartup sweeps
// leftovers (killLeftoverSidecars).
//
// Safety: a recorded pgid is only killed when a live process in that group
// still runs the recorded command — the same pgid-reuse guard the harness
// layer uses (the OS recycles pgids; blindly killing them would eventually
// murder an unrelated process).

package stt

import (
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// sidecarEntry is one persisted sidecar registration: the process group id
// plus the server command it was spawned with (the reuse guard's identity).
type sidecarEntry struct {
	PGID int    `json:"pgid"`
	Cmd  string `json:"cmd"`
}

// readSidecarEntries loads the registry; missing/corrupt file = empty (fail
// open: never kill based on a guess).
func readSidecarEntries(path string) []sidecarEntry {
	if path == "" {
		return nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var ents []sidecarEntry
	if err := json.Unmarshal(b, &ents); err != nil {
		return nil
	}
	return ents
}

// writeSidecarEntries persists the registry (best-effort: a failed write
// only means a leftover survives the next sweep — never a wrong kill).
func writeSidecarEntries(path string, ents []sidecarEntry) {
	if path == "" {
		return
	}
	if ents == nil {
		ents = []sidecarEntry{}
	}
	b, err := json.Marshal(ents)
	if err != nil {
		return
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		slog.Warn("stt: write sidecar pgid file", "err", err)
	}
}

// mutateSidecarEntries applies fn to the persisted entries under s.pgidMu.
func (s *Service) mutateSidecarEntries(fn func([]sidecarEntry) []sidecarEntry) {
	s.pgidMu.Lock()
	defer s.pgidMu.Unlock()
	ents := fn(readSidecarEntries(s.pgidFile))
	writeSidecarEntries(s.pgidFile, ents)
}

// registerSidecar records a freshly spawned sidecar's process group.
func (s *Service) registerSidecar(pgid int, cmd string) {
	s.mutateSidecarEntries(func(ents []sidecarEntry) []sidecarEntry {
		return append(ents, sidecarEntry{PGID: pgid, Cmd: cmd})
	})
}

// unregisterSidecar drops a sidecar's registration (its process exited and
// was reaped); no-op for unknown pgids.
func (s *Service) unregisterSidecar(pgid int) {
	s.mutateSidecarEntries(func(ents []sidecarEntry) []sidecarEntry {
		out := ents[:0]
		for _, e := range ents {
			if e.PGID != pgid {
				out = append(out, e)
			}
		}
		return out
	})
}

// sidecarGroupsByCmd lists live processes as pgid → command lines (one ps
// call). Empty map on any failure (fail open: sweep kills nothing).
func sidecarGroupsByCmd() map[int][]string {
	out, err := exec.Command("ps", "-eo", "pgid=,command=").Output()
	if err != nil {
		return nil
	}
	groups := map[int][]string{}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		pgid, err := strconv.Atoi(fields[0])
		if err != nil || pgid <= 0 {
			continue
		}
		groups[pgid] = append(groups[pgid], line)
	}
	return groups
}

// killLeftoverSidecars sweeps process groups recorded by a previous run:
// each entry is killed (whole group, SIGKILL) only when some live process in
// that group still runs the recorded command, then the registry is reset for
// the new run. Returns the number of groups killed.
func killLeftoverSidecars(path string) int {
	ents := readSidecarEntries(path)
	if len(ents) == 0 {
		return 0
	}
	groups := sidecarGroupsByCmd()
	killed := 0
	for _, e := range ents {
		lines, live := groups[e.PGID]
		if !live {
			continue // already dead (or pgid out of range): nothing to do
		}
		match := false
		for _, l := range lines {
			if strings.Contains(l, e.Cmd) {
				match = true
				break
			}
		}
		if !match {
			continue // pgid reused by an unrelated process: NEVER kill (§3.2 guard)
		}
		if err := syscall.Kill(-e.PGID, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
			slog.Warn("stt: kill leftover sidecar group", "pgid", e.PGID, "err", err)
			continue
		}
		killed++
	}
	if killed > 0 {
		slog.Info("stt: killed leftover sidecar processes from previous run", "count", killed)
	}
	writeSidecarEntries(path, nil) // fresh registry for this run
	return killed
}
