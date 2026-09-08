-- Task 4-11: the record of people who asked not to be contacted.
--
-- Deleting a contact row is not erasure on its own: the next `contact_search`
-- reads the same About page and writes the same address back. The suppression
-- list is what makes an erasure request stick — `saveContacts` refuses to write
-- anything it names, so the deletion survives every later run.
--
-- It deliberately holds the identifier and nothing else. Keeping a name or a
-- reason for the person's own words would defeat the request; a hash is not used
-- either, because the address has to be comparable against fresh scrapes.

CREATE TABLE contact_suppressions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Exactly one of the two is set: a single mailbox, or a whole storefront.
  email      TEXT,
  domain     TEXT,
  -- 'erasure_request' (GDPR art. 17) | 'objection' (art. 21) | 'manual'
  reason     TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CHECK ((email IS NOT NULL) <> (domain IS NOT NULL))
);

CREATE UNIQUE INDEX idx_suppressions_email ON contact_suppressions (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX idx_suppressions_domain ON contact_suppressions (domain)
  WHERE domain IS NOT NULL;
