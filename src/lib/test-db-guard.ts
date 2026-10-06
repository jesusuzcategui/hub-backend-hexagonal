const THROWAWAY_NAME = /(_it|_test|_rem|_ser)$/;

function databaseName(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
}

// Under vitest, refuse to open a connection to a database that is not an obvious throwaway one: a plain
// `vitest run` loads .env and would otherwise create and delete rows in the developer's real database.
// Production and the migrate script never run under vitest, so they are not affected.
export function assertSafeTestDb(url: string, vars: { VITEST?: string; ALLOW_DEV_DB?: string }): void {
  if (!vars.VITEST || vars.ALLOW_DEV_DB === "true") return;

  const name = databaseName(url);
  if (name !== null && THROWAWAY_NAME.test(name)) return;

  throw new Error(
    `Refusing to run tests against database "${name ?? "(unparsable url)"}": it does not end in _it, _test, _rem or _ser. ` +
      `Point DATABASE_URL at a throwaway database, or set ALLOW_DEV_DB=true to use this one on purpose.`,
  );
}
