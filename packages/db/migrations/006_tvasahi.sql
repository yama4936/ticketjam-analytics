INSERT INTO source_state(source) VALUES('tvasahi') ON CONFLICT DO NOTHING;
INSERT INTO official_sources(url) VALUES('https://ticket.tv-asahi.co.jp/ex/project/gift') ON CONFLICT DO NOTHING;
