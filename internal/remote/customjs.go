package remote

// customJS is the browser-side WebSocket bootstrap served at /wails/custom.js.
// The bundled @wailsio/runtime loads this path optionally (loadOptionalScript):
// inside the desktop webview the asset chain 404s it and the runtime silently
// skips it — only real browsers establish the remote event channel.
//
// Adapted from Wails3's server-mode customJS (wails/v3 pkg/application,
// application_server.go, MIT license; see THIRD_PARTY_LICENSES.md), with two
// additions: (1) window.__mdRemote marks remote-browser context; (2) on
// (re)connect it dispatches "remote:resync" so the frontend can re-pull
// snapshots — the WS bridge does not replay events missed while disconnected
// (AGENTS.md §1.8).
const customJS = `(function() {
	// Marker: this context is a REMOTE browser client (the desktop webview gets
	// a 404 for this file). Lets the UI tailor messaging when the remote server
	// itself is down (a remote client cannot bring it back).
	window.__mdRemote = true;
	var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
	var clientId = window._wails && window._wails.clientId ? window._wails.clientId : '';
	var wsUrl = protocol + '//' + location.host + '/wails/events' + (clientId ? '?clientId=' + encodeURIComponent(clientId) : '');
	var ws;

	// Auth escape hatch (N1): expired/revoked cookies turn every binding POST
	// into a silent 401 (the runtime throws and callers swallow errors), which
	// left a frozen-but-clickable shell with no way back to pairing. Poll the
	// health endpoint when the socket dies repeatedly: an unauthenticated
	// document reload makes the server serve the pairing page for "/".
	function checkAuth() {
		fetch('/health').then(function(r) {
			if (r.status === 401) location.reload();
		}).catch(function() {});
	}

	function dispatch(event) {
		if (window._wails && window._wails.dispatchWailsEvent) {
			window._wails.dispatchWailsEvent(event);
		}
	}

	function connect() {
		ws = new WebSocket(wsUrl);
		ws.onopen = function() {
			// Reconnect implies a possible event gap (no server-side replay):
			// nudge the frontend to resync its snapshots.
			dispatch({ name: 'remote:resync', data: null });
		};
		ws.onmessage = function(e) {
			try {
				var event = JSON.parse(e.data);
				if (event && event.name) {
					dispatch(event);
				}
			} catch (err) {
				console.error('[md-remote] Failed to parse event:', err);
			}
		};
		ws.onclose = function() {
			// A closed WS is either a server restart or dead auth: check once,
			// then retry. The reload lands on the pairing page when the cookie
			// no longer authenticates (server serves it for "/" on 401).
			checkAuth();
			setTimeout(connect, 1000);
		};
		ws.onerror = function() {
			ws.close();
		};
	}

	// Foreground recovery: a backgrounded PWA gets frozen by the OS; the
	// socket may die WITHOUT delivering onclose (half-open). On returning to
	// the foreground, verify the connection immediately instead of waiting
	// for the (possibly throttled) reconnect timer — and reconcile even when
	// the socket still reads OPEN, since a half-open link delivers nothing.
	document.addEventListener('visibilitychange', function() {
		if (document.visibilityState !== 'visible') return;
		// readyState !== OPEN: if CONNECTING, the pending onopen will dispatch
		// resync (dispatching here too caused a double resync per wake-up);
		// if CLOSING/CLOSED, reconnect now. Either way the socket ends up
		// reconciling exactly once.
		if (!ws || ws.readyState !== 1) { connect(); return; }
		// Socket reads OPEN: still reconcile — a half-open link delivers
		// nothing, and dispatch is cheap compared to a missed event gap.
		dispatch({ name: 'remote:resync', data: null });
	});

	connect();
})();`
