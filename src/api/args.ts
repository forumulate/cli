/**
 * Argument parsing for `forumulate api` and the resource commands.
 *
 * The older commands parse against a fixed list of value flags. These cannot:
 * `forumulate api` takes a flag per API parameter, and there are a thousand of
 * them. So the rule is inverted — every `--flag` takes the next token as its
 * value unless it is a known switch, the next token is itself a flag, or the
 * flag is written `--flag=value`. `--no-x` is `x=false`.
 */
export interface Parsed {
  positionals: string[];
  /** Every value given for a flag, in order (a flag may repeat). */
  flags: Map<string, string[]>;
}

/** Flags that never take a value. */
export const SWITCHES = new Set([
  'json',
  'paginate',
  'yes',
  'y',
  'help',
  'h',
  'dry-run',
  'verbose',
  'include-headers',
  'publish',
  'all',
  'force',
]);

const SHORT: Record<string, string> = {
  f: 'field',
  H: 'header',
  d: 'data',
  p: 'param',
  y: 'yes',
  h: 'help',
  i: 'include-headers',
};

export function parseArgs(argv: string[], switches: Set<string> = SWITCHES): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (k: string, v: string) => flags.set(k, [...(flags.get(k) ?? []), v]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let name: string | undefined;
    if (a.startsWith('--') && a.length > 2) name = a.slice(2);
    else if (/^-[a-zA-Z]$/.test(a)) name = SHORT[a.slice(1)] ?? a.slice(1);
    if (name === undefined) {
      positionals.push(a);
      continue;
    }
    const eq = name.indexOf('=');
    if (eq > 0) {
      add(name.slice(0, eq), name.slice(eq + 1));
      continue;
    }
    if (switches.has(name)) {
      add(name, 'true');
      continue;
    }
    if (name.startsWith('no-')) {
      add(name.slice(3), 'false');
      continue;
    }
    const next = argv[i + 1];
    // `--data -` is stdin, so a lone dash is a value, not a flag.
    if (next !== undefined && (next === '-' || !next.startsWith('-') || /^-\d/.test(next))) {
      add(name, next);
      i++;
    } else add(name, 'true');
  }
  return { positionals, flags };
}

export const flag = (p: Parsed, name: string): string | undefined => p.flags.get(name)?.at(-1);
export const has = (p: Parsed, name: string): boolean => {
  const v = flag(p, name);
  return v !== undefined && v !== 'false';
};
export const all = (p: Parsed, name: string): string[] => p.flags.get(name) ?? [];
