CREATE TRIGGER admin_keep_owner BEFORE UPDATE OF role, enabled ON admin_user
WHEN OLD.role='owner' AND OLD.enabled=1 AND (NEW.role!='owner' OR NEW.enabled!=1)
BEGIN
  SELECT RAISE(ABORT, 'last_owner') WHERE NOT EXISTS (
    SELECT 1 FROM admin_user WHERE role='owner' AND enabled=1 AND id!=OLD.id
  );
END;
