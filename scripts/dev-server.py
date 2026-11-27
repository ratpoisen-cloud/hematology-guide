#!/usr/bin/env python3
"""
Development HTTP Server with Minzdrav CR Proxy
Serves static files and forwards /api/cr-proxy/* requests to https://apicr.minzdrav.gov.ru/
"""

import http.server
import socketserver
import urllib.request
import urllib.error
import urllib.parse
import shutil
import sys
import os

PORT = 8000
BIND = "127.0.0.1"
UPSTREAM = "https://apicr.minzdrav.gov.ru"

class ProxyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Allow CORS for development
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        if self.path.startswith('/api/cr-proxy/'):
            self.proxy_request('POST')
        else:
            self.send_error(404, "Not Found")

    def do_GET(self):
        if self.path.startswith('/api/cr-proxy/'):
            self.proxy_request('GET')
        else:
            super().do_GET()

    def proxy_request(self, method):
        sub_path = self.path[len('/api/cr-proxy/'):]
        target_url = f"{UPSTREAM}/{sub_path}"
        
        body = None
        if method == 'POST':
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length > 0:
                body = self.rfile.read(content_length)

        req_headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            'Accept': '*/*',
        }
        if self.headers.get('Content-Type'):
            req_headers['Content-Type'] = self.headers.get('Content-Type')

        req = urllib.request.Request(target_url, data=body, headers=req_headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                self.send_response(resp.status)
                for header, value in resp.getheaders():
                    if header.lower() not in ['access-control-allow-origin', 'transfer-encoding']:
                        self.send_header(header, value)
                self.end_headers()
                shutil.copyfileobj(resp, self.wfile)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            shutil.copyfileobj(e, self.wfile)
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(f'{{"error": "{str(e)}"}}'.encode('utf-8'))

def run():
    os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((BIND, PORT), ProxyHTTPRequestHandler) as httpd:
        print(f"Dev server running with CR proxy on http://{BIND}:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass

if __name__ == '__main__':
    run()
