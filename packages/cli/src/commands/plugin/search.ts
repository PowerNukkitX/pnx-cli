import { type RunContext } from '../../cli/define.js';
import { askText, isInteractive } from '../../ui/kit.js';
import { renderList } from './list.js';

/**
 * A search is a list with a question in front of it.
 *
 * The same renderer runs underneath, so a search answer and a browse answer
 * look identical apart from what they contain - and the one `intro` they share
 * comes from the list, whichever door led there.
 */
export async function searchCommand(ctx: RunContext): Promise<void> {
    const passed = ctx.args.positionals[0];
    if (passed) {
        await renderList({ q: passed, limit: 20, page: 1 });
        return;
    }

    if (!isInteractive()) {
        await renderList({ sort: 'stars', limit: 20, page: 1 });
        return;
    }

    const term = await askText({ message: 'Search plugins', placeholder: 'worldedit, chat...' });
    await renderList({ q: String(term).trim(), limit: 20, page: 1 });
}
