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


# Отдаём только то, что уходит на сайт при выкладке (см. .github/workflows/deploy.yml).
# Белый список, а не чёрный: сервер запускается из корня проекта, где лежат токен
# бота (telegram_config.json), .git и tools/ — с --lan их увидела бы вся сеть.
ALLOWED_FILES = {'index.html', 'style.css', 'app.js', 'config.js', 'sw.js',
                 'manifest.json', 'robots.txt'}
ALLOWED_DIRS = {'icons', 'data', 'audio'}
DENIED = {'data/wod_history.json'}          # история рассылки на сайт тоже не попадает


def allowed(url_path):
    path = url_path.split('?', 1)[0].split('#', 1)[0].lstrip('/')
    if path in ('', 'index.html'):
        return True
    parts = path.split('/')
    if any(not x or x.startswith('.') or x == '..' for x in parts) or path in DENIED:
        return False
    return path in ALLOWED_FILES if len(parts) == 1 else parts[0] in ALLOWED_DIRS


class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        if not allowed(self.path):
            self.send_error(404)
            return None
        return super().send_head()

    def list_directory(self, path):          # содержимое папок не показываем
        self.send_error(404)
        return None

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
