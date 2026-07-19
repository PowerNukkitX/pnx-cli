import { text, confirm, select, multiselect, isCancel } from '@clack/prompts';
import { cancel } from './output.js';
export async function promptText(opts) {
    const res = await text(opts);
    if (isCancel(res))
        cancel();
    return res;
}
export async function promptConfirm(message, initialValue = false) {
    const res = await confirm({ message, initialValue });
    if (isCancel(res))
        cancel();
    return res;
}
export async function promptSelect(message, options) {
    const res = await select({ message, options: options });
    if (isCancel(res))
        cancel();
    return res;
}
export async function promptMulti(message, options, required = false) {
    const res = await multiselect({ message, options: options, required });
    if (isCancel(res))
        cancel();
    return res;
}
