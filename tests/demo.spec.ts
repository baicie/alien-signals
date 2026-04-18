import { expect, test } from 'vitest';
import { computed, signal } from '../src';

test('demo', () => {
	const a = signal(0);
	const b = computed(() => a() + 1);
	const c = computed(() => b() + 2);

	expect(c()).toBe(3);
});