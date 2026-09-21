-- 006_auth_functions.sql
-- SECURITY DEFINER functions are the ONLY way app_user touches
-- organizations (on creation) and sessions. Everything else in the app
-- goes through normal RLS-scoped queries (see apps/web/lib/db/tenant.ts).
--
-- These functions run as their owner (the migration role, e.g. `postgres`),
-- not as app_user, so they can bypass RLS deliberately and only for the
-- exact narrow operation each one performs. This is the standard Postgres
-- pattern for "operations that must cross tenant boundaries by design"
-- (signup creates a brand new org; login must find a user before any org
-- context exists).

-- signup_organization: atomically creates an org + its first (owner) user.
-- Password hashing happens in the app (bcrypt) — this function only stores
-- the resulting hash, never a plaintext password.
CREATE OR REPLACE FUNCTION signup_organization(
  p_org_name   text,
  p_org_slug   text,
  p_email      citext,
  p_password_hash text,
  p_full_name  text
) RETURNS TABLE(org_id uuid, user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org_id uuid;
  v_user_id uuid;
BEGIN
  INSERT INTO organizations (name, slug) VALUES (p_org_name, p_org_slug)
    RETURNING id INTO v_org_id;

  INSERT INTO users (org_id, email, password_hash, role, full_name)
    VALUES (v_org_id, p_email, p_password_hash, 'owner', p_full_name)
    RETURNING id INTO v_user_id;

  RETURN QUERY SELECT v_org_id, v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION signup_organization(text, text, citext, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION signup_organization(text, text, citext, text, text) TO app_user;

-- find_user_by_email: used only during login, before any org context is
-- known. Returns the password hash so the app can verify it; the app then
-- calls create_session with the now-known org_id.
CREATE OR REPLACE FUNCTION find_user_by_email(p_email citext)
RETURNS TABLE(user_id uuid, org_id uuid, password_hash text, role user_role)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, org_id, password_hash, role FROM users WHERE email = p_email;
$$;

REVOKE ALL ON FUNCTION find_user_by_email(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_user_by_email(citext) TO app_user;

-- create_session: stores a session keyed by sha256(token) (the app never
-- persists the raw token).
CREATE OR REPLACE FUNCTION create_session(
  p_session_id text,
  p_user_id uuid,
  p_org_id uuid,
  p_expires_at timestamptz
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO sessions (id, user_id, org_id, expires_at)
  VALUES (p_session_id, p_user_id, p_org_id, p_expires_at);
$$;

REVOKE ALL ON FUNCTION create_session(text, uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_session(text, uuid, uuid, timestamptz) TO app_user;

-- resolve_session: given a token hash, returns the (still-valid) session's
-- user/org, or nothing. This is what every authenticated request calls
-- first, BEFORE `app.current_org_id` can be set for that connection.
CREATE OR REPLACE FUNCTION resolve_session(p_session_id text)
RETURNS TABLE(user_id uuid, org_id uuid, role user_role)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
    SELECT u.id, u.org_id, u.role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = p_session_id AND s.expires_at > now();
END;
$$;

REVOKE ALL ON FUNCTION resolve_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_session(text) TO app_user;

-- destroy_session: logout.
CREATE OR REPLACE FUNCTION destroy_session(p_session_id text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM sessions WHERE id = p_session_id;
$$;

REVOKE ALL ON FUNCTION destroy_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION destroy_session(text) TO app_user;
