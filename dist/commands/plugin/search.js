import { defineCommand } from 'citty';
import { promptText } from '../../ui/prompts.js';
import { renderList } from './list.js';
export const searchCmd = defineCommand({
    meta: { description: 'Search plugins' },
    args: { term: { type: 'positional', description: 'Search term', required: false } },
    async run({ args }) {
        const term = args.term ?? await promptText({ message: "Search plugins:" });
        await renderList({ q: term, limit: 20, page: 1 });
    },
});
