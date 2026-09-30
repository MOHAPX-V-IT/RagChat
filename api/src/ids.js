import { randomUUID } from 'node:crypto';

export const id = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 18)}`;

