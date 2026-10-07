"""Exercise the deployed frontend, authenticated API, and WebSocket through Caddy."""
import argparse
import asyncio
import base64
import json
import os
from pathlib import Path
import urllib.error
import urllib.request
import websockets

parser = argparse.ArgumentParser()
parser.add_argument('--base', default='http://localhost')
parser.add_argument('--credentials-file', type=Path)
args = parser.parse_args()
password = os.getenv('MEETINTEL_TEST_PASSWORD', '')
if args.credentials_file:
    password = next(line.split(': ', 1)[1] for line in args.credentials_file.read_text().splitlines()
                    if line.startswith('Login password (save securely): '))
if not password:
    raise SystemExit('Provide MEETINTEL_TEST_PASSWORD or --credentials-file from deployment/setup.py output.')
authorization = 'Basic ' + base64.b64encode(('admin:' + password).encode()).decode()


def request(path, method='GET', body=None):
    payload = json.dumps(body if body is not None else {}).encode() if method != 'GET' else None
    req = urllib.request.Request(args.base + path, data=payload, method=method,
                                 headers={'Authorization': authorization, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as response:
        data = response.read().decode()
        return json.loads(data) if path.startswith('/api') else data


async def verify():
    try:
        urllib.request.urlopen(args.base, timeout=10)
        raise AssertionError('Gateway allowed an unauthenticated request')
    except urllib.error.HTTPError as error:
        assert error.code == 401
    assert 'MeetIntel' in request('/')
    health = request('/api/health')
    assert health['database'] == 'connected' and health['mode'] == 'demo'
    session = request('/api/session/start', 'POST', {'title': 'Deployment integration check', 'participants': ['Test organizer', 'Test participant']})
    sid = session['id']
    try:
        url = args.base.replace('https://', 'wss://').replace('http://', 'ws://') + '/api/ws/transcribe?session_id=' + sid
        async with websockets.connect(url, extra_headers={'Authorization': authorization}, origin=args.base, open_timeout=15) as ws:
            events = [json.loads(await asyncio.wait_for(ws.recv(), timeout=15)) for _ in range(4)]
            assert [event['type'] for event in events] == ['transcript', 'transcript', 'transcript', 'action_item']
        item = events[-1]
        request(f"/api/sessions/{sid}/actions/{item['id']}", 'PATCH', {'done': True})
        assert request('/api/session/pause', 'POST')['status'] == 'paused'
        assert request('/api/session/stop', 'POST')['status'] == 'ended'
        debrief = request('/api/debrief/generate?session_id=' + sid, 'POST')
        assert debrief['transcript_segments'] == 3 and debrief['action_items'][0]['done']
        print('PASS: protected frontend, PostgreSQL persistence, WebSocket events, pause/stop, task update, and debrief through Caddy')
    finally:
        current = request('/api/session/current')
        if current.get('id') == sid and current.get('status') in ('active', 'paused'):
            request('/api/session/stop', 'POST')


asyncio.run(verify())
