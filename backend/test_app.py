"""Exercise real HTTP/WebSocket flows and durable writes, without API credentials."""
import os
import tempfile
import unittest
from pathlib import Path

_directory = tempfile.TemporaryDirectory()
os.environ['DATABASE_URL'] = os.getenv('TEST_DATABASE_URL', 'sqlite:///' + (Path(_directory.name) / 'test.db').as_posix())
os.environ['DEMO_MODE'] = 'true'
os.environ['GOOGLE_API_KEY'] = ''
os.environ['DEEPGRAM_API_KEY'] = ''
from fastapi.testclient import TestClient
from main import app
import main
from services import store


class ApplicationTest(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        store.engine.dispose()
        _directory.cleanup()

    def test_complete_meeting_and_restart(self):
        with TestClient(app) as client:
            self.assertEqual(client.get('/health').json()['database'], 'connected')
            session = client.post('/session/start', json={'title': 'Integration test', 'participants': ['Parth', 'Aryan']}).json()
            sid = session['id']
            self.assertEqual(client.post('/session/start', json={}).status_code, 409)
            with client.websocket_connect(f'/ws/transcribe?session_id={sid}') as ws:
                events = [ws.receive_json() for _ in range(4)]
                self.assertEqual([event['type'] for event in events], ['transcript', 'transcript', 'transcript', 'action_item'])
                self.assertTrue(all(event.get('demo') for event in events))
            item = client.get(f'/sessions/{sid}').json()['action_items'][0]
            self.assertEqual(client.patch(f"/sessions/{sid}/actions/{item['id']}", json={'done': True}).status_code, 200)
            self.assertEqual(client.post('/session/pause').json()['status'], 'paused')
            self.assertEqual(client.get('/session/current').json()['status'], 'paused')
            self.assertEqual(client.post('/session/stop').json()['status'], 'ended')
            debrief = client.post(f'/debrief/generate?session_id={sid}').json()
            self.assertEqual(debrief['mode'], 'demo')
            self.assertEqual(debrief['transcript_segments'], 3)
            self.assertTrue(debrief['action_items'][0]['done'])
            self.assertFalse(client.post('/debt/query', json={}).json()['items'])
            self.assertEqual(client.get(f'/sessions/{sid}').json()['session']['title'], 'Integration test')
        # Re-entering lifespan reloads the snapshots from the database.
        for mapping in [main._sessions, main._transcripts, main._action_items,
                        main._speaker_maps, main._slide_contexts]:
            mapping.clear()
        with TestClient(app) as client:
            detail = client.get(f'/sessions/{sid}').json()
            self.assertEqual(len(detail['transcripts']), 3)
            self.assertTrue(detail['action_items'][0]['done'])
            self.assertEqual(client.delete(f"/sessions/{sid}/actions/{item['id']}").status_code, 200)
            self.assertEqual(client.get(f'/sessions/{sid}').json()['action_items'], [])
            self.assertEqual(client.patch(f'/sessions/{sid}/actions/missing', json={'done': True}).status_code, 404)
            self.assertEqual(client.get('/sessions/missing').status_code, 404)
            self.assertEqual(client.post('/debrief/generate?session_id=missing').status_code, 404)
        stored = next(payload for payload in store.load() if payload['session']['id'] == sid)
        self.assertEqual(stored['session']['status'], 'ended')
        self.assertEqual(stored['actions'], [])

    def test_reject_unknown_session_and_origin(self):
        from starlette.websockets import WebSocketDisconnect
        with TestClient(app) as client:
            for url in ['/ws/transcribe', '/ws/transcribe?session_id=missing']:
                with self.assertRaises(WebSocketDisconnect):
                    with client.websocket_connect(url):
                        pass
            with self.assertRaises(WebSocketDisconnect):
                with client.websocket_connect('/ws/transcribe', headers={'origin': 'https://evil.example'}):
                    pass


if __name__ == '__main__':
    unittest.main()
