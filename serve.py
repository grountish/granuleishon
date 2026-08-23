#!/usr/bin/env python3
"""Dev server: caching disabled + live reload. Watched files (*.js, *.css,
*.html) are stat-polled; the served page polls /__reload and refreshes
itself whenever the change token moves."""
import http.server
import os

WATCH_EXTS = ('.js', '.css', '.html')

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
    newest = 0
    for name in os.listdir('.'):
        if name.endswith(WATCH_EXTS):
            try:
                newest = max(newest, os.stat(name).st_mtime_ns)
            except OSError:
                pass
    return str(newest).encode()


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
    http.server.test(HandlerClass=NoCacheHandler, port=8000)
