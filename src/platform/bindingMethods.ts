/** Retain binding call signatures without requiring mygo's runtime-specific method properties. */
export type BindingMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Result
    : never;
};
