"""Durable single-workspace session store: SQLite locally, PostgreSQL in Docker."""
from sqlalchemy import create_engine, MetaData, Table, Column, String, JSON, select
from config import cfg

engine = create_engine(cfg.DATABASE_URL, pool_pre_ping=True)
metadata = MetaData()
meetings = Table(
    "meeting_snapshots", metadata,
    Column("id", String(36), primary_key=True),
    Column("started_at", String, nullable=False),
    Column("payload", JSON, nullable=False),
)


def initialize():
    metadata.create_all(engine)


def save(session, transcripts, actions, speakers, slides):
    payload = {"session": session, "transcripts": transcripts,
               "actions": actions, "speakers": speakers, "slides": slides}
    with engine.begin() as connection:
        existing = connection.execute(select(meetings.c.id).where(meetings.c.id == session["id"])).first()
        values = {"started_at": session["started_at"], "payload": payload}
        if existing:
            connection.execute(meetings.update().where(meetings.c.id == session["id"]).values(**values))
        else:
            connection.execute(meetings.insert().values(id=session["id"], **values))


def load():
    with engine.connect() as connection:
        return list(connection.execute(select(meetings.c.payload).order_by(meetings.c.started_at)).scalars())


def healthy():
    with engine.connect() as connection:
        connection.execute(select(meetings.c.id).limit(1))
    return True
