import chalk from 'chalk';
export const c = {
    primary: chalk.hex('#FF6B35'),
    accent: chalk.hex('#FFB347'),
    green: chalk.hex('#4CAF50'),
    red: chalk.hex('#E53935'),
    yellow: chalk.hex('#FFC107'),
    blue: chalk.hex('#6C8EBF'),
    cyan: chalk.hex('#4ECDC4'),
    dim: chalk.dim,
    bold: chalk.bold,
};
export function setColorEnabled(on) {
    chalk.level = on ? (chalk.level || 1) : 0;
}
export { chalk };
