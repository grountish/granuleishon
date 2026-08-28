#!/usr/bin/env python3
"""Dev server: caching disabled + live reload. Watched files (*.js, *.css,
*.html) are stat-polled; the served page polls /__reload and refreshes
itself whenever the change token moves.

The server also watches its own source and re-execs when it changes. A
long-running instance started before an edit to this file keeps running the
old code, and the failure is silent: sources moved into src/ once while a
server from before that change was still watching only the top level, so
nothing auto-reloaded and the browser showed a stale build for days."""
import http.server
import os
import sys

WATCH_EXTS = ('.js', '.css', '.html')
SELF = os.path.abspath(__file__)
SELF_MTIME = os.stat(SELF).st_mtime_ns

RELOAD_SNIPPET = b"""<script>
(() => {
  let token = null;
  setInterval(async () => {
    try {
      const t = await (await fetch('/__reload')).text();
      if (token === null) token = t;
      else if (t !== token) location.reload();
    } catch (e) {}
  }, 500);
})();
</script>
"""


def watch_token():
    # Walks subdirectories too — sources live in src/ and worklets/.
    newest = 0
    for root, dirs, files in os.walk('.'):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d != '__pycache__']
        for name in files:
            if name.endswith(WATCH_EXTS):
                try:
                    newest = max(newest, os.stat(os.path.join(root, name)).st_mtime_ns)
                except OSError:
                    pass
    return str(newest).encode()


def restart_if_self_changed():
    """Re-exec when this file is edited, so the running server is never stale.

    Called after the reply is written, so the poll that triggers it still gets
    its answer; the page just retries half a second later. The listening socket
    is not inheritable across exec, so the new process rebinds the port."""
    try:
        if os.stat(SELF).st_mtime_ns == SELF_MTIME:
            return
    except OSError:
        return
    print('serve.py changed — restarting', flush=True)
    os.execv(sys.executable, [sys.executable, SELF])


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def send_body(self, body, content_type):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/__reload':
            self.send_body(watch_token(), 'text/plain')
            restart_if_self_changed()
            return
        # index.html gets the reload poller injected before </body>.
        if self.path in ('/', '/index.html'):
            try:
                with open('index.html', 'rb') as f:
                    body = f.read()
            except OSError:
                self.send_error(404)
                return
            if b'</body>' in body:
                body = body.replace(b'</body>', RELOAD_SNIPPET + b'</body>', 1)
            else:
                body += RELOAD_SNIPPET
            self.send_body(body, 'text/html; charset=utf-8')
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        if self.path != '/__reload':  # keep the poll out of the log
            super().log_message(fmt, *args)


if __name__ == '__main__':
    print(f'grnsh dev server — watching {"/".join(WATCH_EXTS)} under {os.getcwd()} '
          f'and all subdirectories', flush=True)
    http.server.test(HandlerClass=NoCacheHandler, port=8000)
