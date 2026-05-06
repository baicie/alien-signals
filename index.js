import { signal, computed, effect } from "./esm/index.mjs";

const count = signal(1);
const double = computed(() => count() * 2);
effect(() => console.log(double())); // 打印 2
count(5); // 打印 10
