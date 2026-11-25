export const auricSupportSchema={id:'011_auric_support_requests',sql:`
CREATE TABLE auric.support_requests (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('request','error_report')),
 category text NOT NULL CHECK(category IN ('bug','help','feedback')),
 subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 200),
 message text NOT NULL CHECK(length(message) BETWEEN 1 AND 12000),
 current_path text NOT NULL DEFAULT '', page_title text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','waiting_customer','resolved','closed')),
 priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
 assignee_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 diagnostics jsonb NOT NULL DEFAULT '{}', screenshot bytea, screenshot_mime text,
 fingerprint text NOT NULL, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
 CHECK(screenshot IS NULL OR octet_length(screenshot)<=4194304)
);
CREATE INDEX support_user_created ON auric.support_requests(user_id,created_at DESC,id DESC);
CREATE INDEX support_queue ON auric.support_requests(status,priority,created_at DESC);
CREATE INDEX support_deduplicate ON auric.support_requests(user_id,fingerprint,created_at DESC);
CREATE TABLE auric.support_messages (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 request_id bigint NOT NULL REFERENCES auric.support_requests(id) ON DELETE CASCADE,
 author_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 author_role text NOT NULL CHECK(author_role IN ('customer','admin')),
 visibility text NOT NULL CHECK(visibility IN ('public','internal')),
 message text NOT NULL CHECK(length(message) BETWEEN 1 AND 12000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_messages_request ON auric.support_messages(request_id,id);
CREATE TABLE auric.support_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 request_id bigint NOT NULL REFERENCES auric.support_requests(id) ON DELETE CASCADE,
 actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 action text NOT NULL, changes jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_events_request ON auric.support_events(request_id,id);
GRANT SELECT,INSERT,UPDATE,DELETE ON auric.support_requests,auric.support_messages,auric.support_events TO auric_app;
GRANT USAGE,SELECT ON SEQUENCE auric.support_requests_id_seq,auric.support_messages_id_seq,auric.support_events_id_seq TO auric_app;
`};
