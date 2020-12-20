--------------------------------------------------------------------------------
-- Up
--------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS msgs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT,
    channelId TEXT,
    url TEXT,
    content VARCHAR(3000) UNIQUE
);

CREATE TABLE IF NOT EXISTS blacklist(
    channelId TEXT PRIMARY KEY,
    guildId TEXT NOT NULL
);
