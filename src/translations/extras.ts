/**
 * The smaller `forumulate translations` verbs: removing one translation, a
 * library entry's locale twin, a space's or collection's name, the reader's
 * language switcher default, and the org's own translation provider key.
 *
 * Beside `command.ts` rather than in it so that file stays the dispatcher and
 * the four big verbs; each of these is one SDK call and its confirmation.
 */
import type { TranslationsDeps } from './command';
import { resolveLibrary } from '../content/library';
import { resolveOrg, resolveSpace } from './target';
import type { SyncFiles } from './sync';

export class ExtraUsage extends Error {}

interface Ctx {
  argv: readonly string[];
  rest: readonly string[];
  deps: TranslationsDeps;
  files: SyncFiles;
  want: () => { org?: string; space?: string; library?: string };
  value: (name: string) => string | undefined;
  json: boolean;
}

const confirmed = async (ctx: Ctx, question: string): Promise<boolean> => {
  if (ctx.argv.includes('--yes')) return true;
  if (!ctx.deps.ask) {
    ctx.deps.err('Nothing changed: pass --yes to do this without a prompt.');
    return false;
  }
  const answer = (await ctx.deps.ask(`${question} [y/N] `)).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') return true;
  ctx.deps.err('Nothing changed.');
  return false;
};

/** One of the verbs here, or `null` when `sub` is not one of them. */
export async function runExtra(sub: string | undefined, ctx: Ctx): Promise<number | null> {
  const { deps, rest, value, json } = ctx;
  const t = deps.client.translations;
  const dump = (v: unknown) => deps.out(JSON.stringify(v, null, 2));
  switch (sub) {
    case 'remove': {
      const [pieceId, locale] = rest;
      if (!pieceId || !locale) throw new ExtraUsage('Usage: forumulate translations remove <pieceId> <locale> --space <id|slug> [--yes]');
      const s = await resolveSpace(deps.client, ctx.want());
      if (!(await confirmed(ctx, `Remove the ${locale} translation of ${pieceId}?`))) return 1;
      await t.remove(s.orgId, s.spaceId, pieceId, locale);
      deps.out(`Removed the ${locale} translation of ${pieceId}.`);
      return 0;
    }
    case 'entry': {
      const [entryId, locale] = rest;
      if (!entryId || !locale)
        throw new ExtraUsage('Usage: forumulate translations entry <entryId> <locale> --library <id|slug> [--fields file.json]');
      const lib = await resolveLibrary(deps.client, ctx.want());
      const file = value('--fields');
      if (!file) {
        dump(await t.entryLocale.get(lib.orgId, lib.libraryId, entryId, locale));
        return 0;
      }
      const fields = JSON.parse(ctx.files.read(file)) as Record<string, unknown>;
      const res = await t.entryLocale.put(lib.orgId, lib.libraryId, entryId, locale, fields);
      if (json) dump(res);
      else deps.out(`Wrote the ${locale} draft of ${entryId} (${res.created ? 'new twin ' : ''}${res.entryId}).`);
      return 0;
    }
    case 'name': {
      const [locale, ...words] = rest;
      if (!locale) throw new ExtraUsage('Usage: forumulate translations name <locale> <name…> --space <id|slug> [--collection <id>] [--description …] [--remove]');
      const s = await resolveSpace(deps.client, ctx.want());
      const collectionId = value('--collection');
      const description = value('--description');
      const remove = ctx.argv.includes('--remove');
      if (!remove && !words.length && description === undefined) {
        dump(await t.names.get(s.orgId, s.spaceId, { collectionId }));
        return 0;
      }
      const set = await t.names.set(
        s.orgId,
        s.spaceId,
        locale,
        remove ? null : { ...(words.length ? { name: words.join(' ') } : {}), ...(description !== undefined ? { description } : {}) },
        { collectionId },
      );
      if (json) dump(set);
      else deps.out(remove ? `Removed the ${locale} name.` : `${collectionId ? 'Collection' : `"${s.name}"`} is “${set[locale]?.name ?? ''}” in ${locale}.`);
      return 0;
    }
    case 'switcher': {
      const [verb = 'get', file] = rest;
      const orgId = await resolveOrg(deps.client, ctx.want().org);
      if (verb === 'get') {
        dump(await t.switcher.get(orgId));
        return 0;
      }
      if (verb === 'set' && file) {
        dump(await t.switcher.set(orgId, JSON.parse(ctx.files.read(file)) as Record<string, unknown>));
        return 0;
      }
      throw new ExtraUsage('Usage: forumulate translations switcher get | set <file.json> [--org …]');
    }
    case 'provider': {
      const [verb = 'status'] = rest;
      const orgId = await resolveOrg(deps.client, ctx.want().org);
      if (verb === 'status') {
        const { configured } = await t.deepl.status(orgId);
        if (json) dump({ configured });
        else deps.out(configured ? 'A DeepL key is connected: machine translation uses it.' : 'No translation provider connected (forumulate translations provider connect).');
        return 0;
      }
      if (verb === 'connect') {
        // The key from the environment, never argv: a flag is in shell history.
        const key = (deps.env ?? process.env).DEEPL_API_KEY;
        if (!key) throw new ExtraUsage('Set DEEPL_API_KEY in the environment, then run: forumulate translations provider connect');
        await t.deepl.connect(orgId, key);
        deps.out('DeepL key connected.');
        return 0;
      }
      if (verb === 'disconnect') {
        if (!(await confirmed(ctx, 'Disconnect the DeepL key? Machine translation stops until a key is connected.'))) return 1;
        await t.deepl.disconnect(orgId);
        deps.out('DeepL key removed.');
        return 0;
      }
      throw new ExtraUsage('Usage: forumulate translations provider status|connect|disconnect');
    }
    default:
      return null;
  }
}
