import { filterOps, findById, findByPath, isMethod, loadIndex } from '../api/spec';
import { GROUPS, findGroup } from './groups';
import { CONFIG_KEYS } from './config';

/**
 * Shell completion: `forumulate completion bash|zsh|fish` prints a script, and
 * the script asks the CLI itself (`forumulate __complete <words…>`) what comes
 * next. One source of candidates for three shells, so a verb added to
 * `groups.ts` or an operation added to the spec completes everywhere with no
 * script to regenerate.
 */
export const TOP_LEVEL = [
  'login',
  'logout',
  'whoami',
  'config',
  'api',
  'publish',
  'snapshot',
  'content',
  'import',
  'conformance',
  'doctor',
  'completion',
  'help',
];

const COMMON_FLAGS = ['--json', '--org', '--space', '--paginate', '--dry-run', '--help', '--yes'];

/** Candidates for the word being completed, given the words before it. */
export function complete(words: string[]): string[] {
  const [cmd, ...rest] = words;
  const current = rest.length ? rest[rest.length - 1]! : (cmd ?? '');
  const before = rest.slice(0, -1);
  if (rest.length === 0) {
    const all = [...TOP_LEVEL, ...GROUPS.flatMap((g) => [g.name, ...(g.aliases ?? [])])];
    return all.filter((w) => w.startsWith(current)).sort();
  }
  if (current.startsWith('-')) return flagsFor(cmd!, before).filter((f) => f.startsWith(current));
  const positionals = before.filter((w) => !w.startsWith('-'));
  if (cmd === 'api') {
    if (positionals.length === 0) {
      if (current === '' || /^[A-Z]/.test(current)) {
        const ids = loadIndex().ops.map((o) => o.id);
        return ['list', 'describe', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', ...ids].filter((w) =>
          w.startsWith(current),
        );
      }
      return ['list', 'describe', ...loadIndex().ops.map((o) => o.id)].filter((w) =>
        w.startsWith(current),
      );
    }
    if (positionals[0] === 'describe' && positionals.length === 1)
      return loadIndex()
        .ops.map((o) => o.id)
        .filter((w) => w.startsWith(current));
    if (isMethod(positionals[0]) && positionals.length === 1)
      return filterOps({ method: positionals[0] })
        .map((o) => o.p)
        .filter((p) => p.startsWith(current));
    return [];
  }
  if (cmd === 'config') {
    if (positionals.length === 0)
      return ['set', 'get', 'unset', 'list', 'path'].filter((w) => w.startsWith(current));
    if (positionals.length === 1)
      return Object.keys(CONFIG_KEYS).filter((w) => w.startsWith(current));
    return [];
  }
  if (cmd === 'completion') return ['bash', 'zsh', 'fish'].filter((w) => w.startsWith(current));
  const g = findGroup(cmd!);
  if (!g) return [];
  const verbs = Object.keys(g.verbs);
  if (positionals.length === 0)
    return [...new Set(verbs.map((v) => v.split(' ')[0]!))].filter((w) => w.startsWith(current));
  if (positionals.length === 1)
    return verbs
      .filter((v) => v.startsWith(`${positionals[0]} `))
      .map((v) => v.split(' ')[1]!)
      .filter((w) => w.startsWith(current));
  return [];
}

function flagsFor(cmd: string, before: string[]): string[] {
  const positionals = before.filter((w) => !w.startsWith('-'));
  if (cmd === 'api') {
    const op =
      (positionals[0] && findById(positionals[0])) ||
      (isMethod(positionals[0]) && positionals[1]
        ? findByPath(positionals[0]!, positionals[1])?.op
        : undefined);
    const own = [
      '--data',
      '--field',
      '--param',
      '--header',
      '--paginate',
      '--json',
      '--columns',
      '--dry-run',
      '--api-version',
      '--include-headers',
    ];
    return [...(op?.q ?? []).map((p) => `--${p.n}`), ...own];
  }
  const g = findGroup(cmd);
  if (!g) return COMMON_FLAGS;
  const verb = g.verbs[`${positionals[0]} ${positionals[1]}`] ?? g.verbs[positionals[0] ?? ''];
  const op = verb && findById(verb.op);
  const params = (op?.q ?? []).filter((p) => p.in === 'query').map((p) => `--${p.n}`);
  return [
    ...new Set([
      ...COMMON_FLAGS,
      ...params,
      ...(verb?.markdown ? ['--file'] : []),
      ...(verb?.download ? ['--out'] : []),
      '--data',
      '--field',
    ]),
  ];
}

export function completionScript(shell: string): string | undefined {
  switch (shell) {
    case 'bash':
      return `# forumulate bash completion — add to ~/.bashrc:
#   eval "$(forumulate completion bash)"
_forumulate() {
  local IFS=$'\\n'
  COMPREPLY=($(forumulate __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null))
}
complete -o default -F _forumulate forumulate
`;
    case 'zsh':
      return `#compdef forumulate
# forumulate zsh completion — add to ~/.zshrc:
#   eval "$(forumulate completion zsh)"
_forumulate() {
  local -a candidates
  candidates=("\${(@f)$(forumulate __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  compadd -a candidates
}
compdef _forumulate forumulate
`;
    case 'fish':
      return `# forumulate fish completion — save as ~/.config/fish/completions/forumulate.fish
#   forumulate completion fish > ~/.config/fish/completions/forumulate.fish
complete -c forumulate -f -a '(forumulate __complete (commandline -opc)[2..-1] (commandline -ct) 2>/dev/null)'
`;
    default:
      return undefined;
  }
}
