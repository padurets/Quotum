import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {prepare, Preparations, type Preparation} from '../lib/prepare';

/** Runs the actual preparation hook with explicit render, DOM commit and task phases. */
export function preparationFixture() {
  let index = 0, clock = 0;
  const slots: unknown[] = [], effects: (() => void)[] = [], tasks: (() => void)[] = [];
  const scheduler = new Preparations({now: () => clock++, post: run => tasks.push(run)});
  const useRef = (value: unknown) => slots[index++] ?? (slots[index - 1] = {current: value});
  const useState = (value: unknown) => {
    const at = index++;
    if (!(at in slots)) slots[at] = value;
    return [slots[at], (next: unknown) => {slots[at] = typeof next === 'function' ? next(slots[at]) : next;}];
  };
  const useLayoutEffect = (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const at = index++, old = slots[at] as {deps?: readonly unknown[]; cleanup?: () => void} | undefined;
    if (deps && old?.deps && deps.length === old.deps.length && deps.every((v, i) => Object.is(v, old.deps![i]))) return;
    effects.push(() => {old?.cleanup?.(); slots[at] = {deps, cleanup: effect()};});
  };
  const context = {exports: {} as {usePreparationBasis: (value: {from: number; to: number; end: number}, deps: readonly unknown[], captured: boolean, enabled?: boolean) => {from: number; to: number; end: number}; usePrepared: <T>(work: () => Preparation<T>, deps: readonly unknown[], context?: unknown, enabled?: boolean) => {value: T | null; ready: boolean}}, require: (name: string) => name === 'react' ? {useRef, useState, useLayoutEffect} : {prepare: <T>(owner: object, work: Preparation<T>, valid: () => boolean, ready: (v: T) => void) => prepare(owner, work, valid, ready, scheduler), preparations: () => scheduler}};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/prepared.ts', import.meta.url), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText, context);
  return {useRef, useState, useLayoutEffect, usePrepared: context.exports.usePrepared, usePreparationBasis: context.exports.usePreparationBasis,
    begin: () => {index = 0; effects.length = 0;},
    commit: () => {effects.splice(0).forEach(effect => effect());},
    tick: () => tasks.shift()?.(),
    finish: () => {for (let i = 0; tasks.length && i < 100_000; i++) tasks.shift()!(); if (tasks.length) throw new Error('preparation did not quiesce');},
    scheduler,
  };
}
