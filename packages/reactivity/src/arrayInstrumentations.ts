import { TrackOpTypes } from './constants'
import { endBatch, pauseTracking, resetTracking, startBatch } from './effect'
import { isProxy, isShallow, toRaw, toReactive } from './reactive'
import { ARRAY_ITERATE_KEY, track } from './dep'
import { isArray } from '@vue/shared'


/**
 * 这里全部重写的原因是：Vue 只跟踪了一次数组的迭代操作（ARRAY_ITERATE_KEY），如果我们用 forEach 的方法会对数组中的每个元素都进行追踪，会导致性能问题
 * 不同的数组方法有不同的行为特征：
 *  - 有些方法会修改原数组（如push、pop）
 *  - 有些方法只读取数据（如map、filter）
 *  - 有些方法涉及迭代器（如values、entries）
 * 根据这些差异，使用不同的辅助函数 
 *  - apply - 处理迭代方法
 *  - noTracking - 处理修改长度的方法
 *  - iterator - 处理迭代器方法
 *  - searchProxy - 处理搜索方法
 * 
 * 对返回值的处理更加细致，确保响应式的一致性 return needsWrap && wrappedRetFn ? wrappedRetFn(result) : result
 */

/**
 * 跟踪数组迭代并返回：
 * - 如果输入是响应式：一个克隆的原始数组，包含响应式值
 * - 如果输入是非响应式或浅层响应式：原始原始数组
 */
export function reactiveReadArray<T>(array: T[]): T[] {
  // 获取原始数组
  const raw = toRaw(array)
  // 如果原始数组与输入数组相同，则直接返回原始数组
  if (raw === array) return raw
  // 跟踪数组迭代
  track(raw, TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  // 如果输入是浅层响应式，则返回原始数组，否则返回响应式数组
  return isShallow(array) ? raw : raw.map(toReactive)
}

/**
 * Track array iteration and return raw array
 */
export function shallowReadArray<T>(arr: T[]): T[] {
  track((arr = toRaw(arr)), TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  return arr
}


export const arrayInstrumentations: Record<string | symbol, Function> = <any>{
  __proto__: null,

  [Symbol.iterator]() {
    return iterator(this, Symbol.iterator, toReactive)
  },

  concat(...args: unknown[]) {
    return reactiveReadArray(this).concat(
      ...args.map(x => (isArray(x) ? reactiveReadArray(x) : x)),
    )
  },

  entries() {
    return iterator(this, 'entries', (value: [number, unknown]) => {
      value[1] = toReactive(value[1])
      return value
    })
  },

  every(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'every', fn, thisArg, undefined, arguments)
  },

  filter(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'filter', fn, thisArg, v => v.map(toReactive), arguments)
  },

  find(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(this, 'find', fn, thisArg, toReactive, arguments)
  },

  findIndex(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(this, 'findIndex', fn, thisArg, undefined, arguments)
  },

  findLast(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(this, 'findLast', fn, thisArg, toReactive, arguments)
  },

  findLastIndex(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(this, 'findLastIndex', fn, thisArg, undefined, arguments)
  },

  // flat, flatMap could benefit from ARRAY_ITERATE but are not straight-forward to implement

  forEach(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'forEach', fn, thisArg, undefined, arguments)
  },

  includes(...args: unknown[]) {
    return searchProxy(this, 'includes', args)
  },

  indexOf(...args: unknown[]) {
    return searchProxy(this, 'indexOf', args)
  },

  join(separator?: string) {
    return reactiveReadArray(this).join(separator)
  },

  // keys() iterator only reads `length`, no optimisation required

  lastIndexOf(...args: unknown[]) {
    return searchProxy(this, 'lastIndexOf', args)
  },

  map(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'map', fn, thisArg, undefined, arguments)
  },

  pop() {
    return noTracking(this, 'pop')
  },

  push(...args: unknown[]) {
    return noTracking(this, 'push', args)
  },

  reduce(
    fn: (
      acc: unknown,
      item: unknown,
      index: number,
      array: unknown[],
    ) => unknown,
    ...args: unknown[]
  ) {
    return reduce(this, 'reduce', fn, args)
  },

  reduceRight(
    fn: (
      acc: unknown,
      item: unknown,
      index: number,
      array: unknown[],
    ) => unknown,
    ...args: unknown[]
  ) {
    return reduce(this, 'reduceRight', fn, args)
  },

  shift() {
    return noTracking(this, 'shift')
  },

  // slice could use ARRAY_ITERATE but also seems to beg for range tracking

  some(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'some', fn, thisArg, undefined, arguments)
  },

  splice(...args: unknown[]) {
    return noTracking(this, 'splice', args)
  },

  toReversed() {
    // @ts-expect-error user code may run in es2016+
    return reactiveReadArray(this).toReversed()
  },

  toSorted(comparer?: (a: unknown, b: unknown) => number) {
    // @ts-expect-error user code may run in es2016+
    return reactiveReadArray(this).toSorted(comparer)
  },

  toSpliced(...args: unknown[]) {
    // @ts-expect-error user code may run in es2016+
    return (reactiveReadArray(this).toSpliced as any)(...args)
  },

  unshift(...args: unknown[]) {
    return noTracking(this, 'unshift', args)
  },

  values() {
    return iterator(this, 'values', toReactive)
  },
}

// 对迭代器进行工具化处理，使其依赖 ARRAY_ITERATE。
function iterator(
  self: unknown[],
  method: keyof Array<unknown>,
  wrapValue: (value: any) => unknown,
) {
  // 注意，这里获取ARRAY_ITERATE依赖与在代理数组上调用迭代方法并不严格等价。
  // 创建迭代器本身不会访问任何数组属性：
  // 只有当调用.next()时才会访问length和索引。
  // 极端情况下，一个迭代器可能在一个effect作用域中被创建，
  // 在另一个作用域中部分迭代，然后在又一个作用域中继续迭代。
  // 考虑到JS迭代器只能被读取一次，这种使用场景似乎不太可能，
  // 所以这种追踪简化方式是可以接受的。

  // 使用 shallowReadArray 处理数组，确保只跟踪浅层读取操作
  const arr = shallowReadArray(self)
  // 使用原始方法创建迭代器
  const iter = (arr[method] as any)() as IterableIterator<unknown> & {
    _next: IterableIterator<unknown>['next']
  }
  // 如果数组不是自身，并且不是浅层代理，则需要对迭代器进行包装
  if (arr !== self && !isShallow(self)) {
    // 保存原始的next方法
    iter._next = iter.next
    // 重写next方法
    iter.next = () => {
      // 调用原始的next方法
      const result = iter._next()
      // 如果结果的value存在，则进行包装
      if (result.value) {
        result.value = wrapValue(result.value)
      }
      // 返回结果
      return result
    }
  }
  // 返回迭代器
  return iter
}

// in the codebase we enforce es2016, but user code may run in environments
// higher than that
type ArrayMethods = keyof Array<any> | 'findLast' | 'findLastIndex'

const arrayProto = Array.prototype
// instrument functions that read (potentially) all items
// to take ARRAY_ITERATE dependency
function apply(
  self: unknown[],
  method: ArrayMethods,
  fn: (item: unknown, index: number, array: unknown[]) => unknown,
  thisArg?: unknown,
  wrappedRetFn?: (result: any) => unknown,
  args?: IArguments,
) {
  const arr = shallowReadArray(self)
  const needsWrap = arr !== self && !isShallow(self)
  // @ts-expect-error our code is limited to es2016 but user code is not
  const methodFn = arr[method]

  // #11759
  // 处理用户扩展的数组方法
  // 如果方法来自用户扩展的 Array，参数将是未知（未知顺序和未知参数类型），在这种情况下，我们跳过 shallowReadArray 处理并直接使用 self 调用 apply。
  if (methodFn !== arrayProto[method as any]) {
    const result = methodFn.apply(self, args)
    return needsWrap ? toReactive(result) : result
  }

  let wrappedFn = fn
  if (arr !== self) {
    if (needsWrap) {
      wrappedFn = function (this: unknown, item, index) {
        return fn.call(this, toReactive(item), index, self)
      }
    } else if (fn.length > 2) {
      wrappedFn = function (this: unknown, item, index) {
        return fn.call(this, item, index, self)
      }
    }
  }
  const result = methodFn.call(arr, wrappedFn, thisArg)
  return needsWrap && wrappedRetFn ? wrappedRetFn(result) : result
}

// 对 reduce 和 reduceRight 进行工具化处理，使其依赖 ARRAY_ITERATE。
// ARRAY_ITERATE。
function reduce(
  self: unknown[],
  method: keyof Array<any>,
  fn: (acc: unknown, item: unknown, index: number, array: unknown[]) => unknown,
  args: unknown[],
) {
  // 使用 shallowReadArray 处理数组，确保只跟踪浅层读取操作
  const arr = shallowReadArray(self)
  let wrappedFn = fn
  if (arr !== self) {
    // 如果数组不是自身，并且不是浅层代理，则需要对函数进行包装
    if (!isShallow(self)) {
      wrappedFn = function (this: unknown, acc, item, index) {
        return fn.call(this, acc, toReactive(item), index, self)
      }
    } else if (fn.length > 3) {
      // 如果函数参数长度大于3，则需要对函数进行包装
      wrappedFn = function (this: unknown, acc, item, index) {
        return fn.call(this, acc, item, index, self)
      }
    }
  }
  // 使用原始方法调用，传入包装后的函数和参数
  return (arr[method] as any)(wrappedFn, ...args)
}

// instrument identity-sensitive methods to account for reactive proxies
function searchProxy(
  self: unknown[],
  method: keyof Array<any>,
  args: unknown[],
) {
  const arr = toRaw(self) as any
  track(arr, TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  // we run the method using the original args first (which may be reactive)
  const res = arr[method](...args)

  // if that didn't work, run it again using raw values.
  if ((res === -1 || res === false) && isProxy(args[0])) {
    args[0] = toRaw(args[0])
    return arr[method](...args)
  }

  return res
}

// 处理改变长度的变异方法，避免长度被追踪
// 这可以防止在某些情况下出现无限循环(#2137)
function noTracking(
  self: unknown[],
  method: keyof Array<any>,
  args: unknown[] = [],
) {
  // 暂停追踪
  pauseTracking()
  // 开始批量追踪
  startBatch()
  // 使用原始方法调用，传入参数
  const res = (toRaw(self) as any)[method].apply(self, args)
  // 结束批量追踪
  endBatch()
  // 重置追踪
  resetTracking()
  // 返回结果
  return res
}
