# -*- coding: utf-8 -*-
"""Локальный сервер приложения: отдаёт файлы без кэширования, чтобы обновления подхватывались сразу."""
import http.server, socketserver, os, sys, socket

PORT = 8778
# по умолчанию сервер виден только этому Маку; --lan открывает его телефону в той же сети
HOST = '0.0.0.0' if '--lan' in sys.argv else '127.0.0.1'
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # корень проекта


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('192.168.255.255', 1))
        return s.getsockname()[0]
    except Exception:
        return '127.0.0.1'
    finally:
        s.close()


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # аудио кэшировать полезно, остальное — нет
        if self.path.endswith('.mp3'):
            self.send_header('Cache-Control', 'public, max-age=604800')
        else:
            self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Service-Worker-Allowed', '/')
        super().end_headers()

    def log_message(self, *a):
        pass


Handler.extensions_map.update({'.json': 'application/json', '.mp3': 'audio/mpeg',
                               '.js': 'text/javascript', '.webmanifest': 'application/manifest+json'})
socketserver.TCPServer.allow_reuse_address = True

with socketserver.ThreadingTCPServer((HOST, PORT), Handler) as httpd:
    print(f'на этом Маке:  http://127.0.0.1:{PORT}/')
    if HOST == '0.0.0.0':
        print(f'с телефона:    http://{lan_ip()}:{PORT}/')
    httpd.serve_forever()
