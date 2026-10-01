import {people, type DemoSet} from './model.js';

/** Synthetic fixture defaults, shared by seeding, the greeting and managed stand info. */
export const PASSWORD = 'quotum-demo';
export const emailOf = (person: string) => `${person}@demo.quotum`;
export const accessOf = (set: DemoSet) => ({password: PASSWORD, accounts: people(set).map(p => ({email: emailOf(p.id), name: p.name}))});
