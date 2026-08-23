/** A successful computation. */
export interface Success<T> {
  readonly _tag: "ok";
  readonly value: T;
}

/** A failed expected computation. */
export interface Failure<E> {
  readonly _tag: "err";
  readonly error: E;
}

/** The result of a computation that can fail in an expected way. */
export type Result<T, E> = Success<T> | Failure<E>;

/** Construct a successful result. */
export const ok = <T>(value: T): Success<T> => ({ _tag: "ok", value });

/** Construct a failed result. */
export const err = <E>(error: E): Failure<E> => ({ _tag: "err", error });
