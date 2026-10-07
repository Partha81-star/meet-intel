"""Generate Docker secrets without sending credentials to a shell or source control."""
import argparse
import os
import secrets
import subprocess
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--domain', help='Public DNS hostname pointing to your server')
args = parser.parse_args()
target = ROOT / '.env'
if target.exists():
    raise SystemExit('.env already exists; edit it instead of overwriting existing secrets.')
if args.domain and (urlparse('https://' + args.domain).hostname != args.domain or ':' in args.domain or '/' in args.domain):
    raise SystemExit('Use a DNS hostname such as meet.example.com, without a URL scheme or port.')
password = secrets.token_urlsafe(24)
hashed = subprocess.run(
    ['docker', 'run', '--rm', '-i', 'caddy:2-alpine', 'caddy', 'hash-password'],
    input=password + '\n', text=True, capture_output=True,
)
if hashed.returncode:
    raise SystemExit('Could not generate the access password hash. Ensure Docker is running.\n' + hashed.stderr)
hash_value = next((line.strip() for line in hashed.stdout.splitlines() if line.strip().startswith('$2')), None)
if not hash_value:
    raise SystemExit('Caddy did not return a bcrypt hash. No environment file was written.')
site = 'https://' + args.domain if args.domain else 'http://localhost'
values = (ROOT / '.env.production.example').read_text().replace('SITE_ADDRESS=http://localhost', 'SITE_ADDRESS=' + site)
values = values.replace('CORS_ORIGINS=http://localhost', 'CORS_ORIGINS=' + site)
values = values.replace('BIND_ADDRESS=127.0.0.1', 'BIND_ADDRESS=' + ('0.0.0.0' if args.domain else '127.0.0.1'))
values = values.replace('SITE_PASSWORD_HASH=', "SITE_PASSWORD_HASH='" + hash_value + "'")
values = values.replace('POSTGRES_PASSWORD=', 'POSTGRES_PASSWORD=' + secrets.token_hex(32))
target.write_text(values, encoding='utf-8')
if os.name != 'nt':
    target.chmod(0o600)
print(f'Created {target}. Login username: admin')
print(f'Login password (save securely): {password}')
print('Start: docker compose up --build -d --wait')
