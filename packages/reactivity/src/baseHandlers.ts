import {
  hasChanged,
  hasOwn,
  isArray,
  isIntegerKey,
  isObject,
  isSymbol,
  makeMap,
} from '@vue/shared'
import { arrayInstrumentations } from './arrayInstrumentations'
import { ReactiveFlags, TrackOpTypes, TriggerOpTypes } from './constants'
import { ITERATE_KEY, track, trigger } from './dep'
import {
  type Target,
  isReadonly,
  isShallow,
  reactive,
  reactiveMap,
  readonly,
  readonlyMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  toRaw,
} from './reactive'
import { isRef } from './ref'
import { warn } from './warning'

// 用于标识不需要追踪的特殊属性
const isNonTrackableKeys = /*@__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

// 内置符号集合
// 获取到如 Symbol.iterator Symbol.toStringTag Symbol.toPrimitive 等内置符号
// 在 Vue 的响应式系统中，这个集合用于识别那些不需要进行依赖追踪的特殊 Symbol 属性。当访问对象的某个属性是内置 Symbol 时，Vue 不会对其进行依赖追踪，这是因为：
// 这些内置 Symbol 通常用于 JavaScript 引擎内部操作,它们很少会在响应式更新中发生变化
// 对它们进行依赖追踪会增加不必要的性能开销
const builtInSymbols = new Set(
  /*@__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    // 过滤掉 'arguments' 和 'caller' 这两个特殊属性（在 iOS 10.x 上会出现问题）
    .filter(key => key !== 'arguments' && key !== 'caller')
    // 将属性名转换为实际的 Symbol 值
    .map(key => Symbol[key as keyof SymbolConstructor])
    // 确保只保留真正的 Symbol 类型值
    .filter(isSymbol),
)

// 重写了对象的 hasOwnProperty 方法，使其能够正确追踪依赖
function hasOwnProperty(this: object, key: unknown) {
  // #10455 hasOwnProperty may be called with non-string values
  if (!isSymbol(key)) key = String(key)
  const obj = toRaw(this)
  track(obj, TrackOpTypes.HAS, key)
  return obj.hasOwnProperty(key as string)
}

/**
 * 基础处理器
 * 接收两个参数：是否是只读的、是否是浅响应式的
 */
class BaseReactiveHandler implements ProxyHandler<Target> {
  constructor(
    protected readonly _isReadonly = false, // 是否只读
    protected readonly _isShallow = false, // 是否浅响应式
  ) {}

  /**
   * 获取代理对象的属性值
   * @param target 目标对象
   * @param key 属性名
   * @param receiver 代理对象
   * @returns 属性值
   * 1. 特殊标志位处理，检查 __v_skip、__v_isReactive、__v_isReadonly 等特殊属性 处理toRaw方法获取原始对象
   * 2. 对数组的特殊方法（如 includes、push 等）进行重写，确保依赖追踪正常工作
   * 3. 费制度对象只能调用track函数收集依赖
   * 4. 如果返回值是对象且不是浅响应式，会递归地将其转换为响应式对象
   * 5. 自动解包 ref 对象（数组的整数索引除外）
   */
  get(target: Target, key: string | symbol, receiver: object): any {
    /**
     * 如果key是__v_skip，则返回target['__v_skip']，
     * 这样标记是为了跳过某些对象不需要被转换为响应式，例如 markRaw标记的对象
     * markRaw 函数的实现
     * function markRaw<T extends object>(value: T): T {
     *   def(value, ReactiveFlags.SKIP, true)
     *   return value
     * }
     *
     * const originalObj = markRaw({ count: 1 })
     * const reactiveObj = reactive(originalObj) // originalObj 不会被转换为响应式
     */
    if (key === ReactiveFlags.SKIP) return target[ReactiveFlags.SKIP]

    // 获取是否只读和是否浅响应式
    const isReadonly = this._isReadonly,
      isShallow = this._isShallow

    // 处理一些标志位的判断函数处理
    // 如 isReactive isReadonly isShallow toRaw
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly // isReactive 实际是访问 target['__v_isReactive']
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly // isReadonly 实际是访问 target['__v_isReadonly']
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      return isShallow // isShallow 实际是访问 target['__v_isShallow']
    } else if (key === ReactiveFlags.RAW) {
      if (
        receiver ===
          (isReadonly
            ? isShallow
              ? shallowReadonlyMap
              : readonlyMap
            : isShallow
              ? shallowReactiveMap
              : reactiveMap
          ).get(target) ||
        // 检查 receiver 是否与 target 有相同的原型 为了避免用户创建自己的代理Proxy
        Object.getPrototypeOf(target) === Object.getPrototypeOf(receiver)
      ) {
        return target
      }
      // early return undefined
      return
    }

    // 判断是数组的话，处理数组的方法和 hasOwnProperty 的特殊情况
    const targetIsArray = isArray(target)

    /**
     * 不是只读的话进行重写处理,保证依赖追踪
     * const arr = reactive([1, reactive({ value: 2 })])
     * console.log(arr.includes(1))  // true
     * console.log(arr.hasOwnProperty('length'))  // true
     * // 依赖追踪也能正常工作
     * effect(()=>{
     *  console.log(arr.includes(1))  // 会建立依赖关系
     * })
     */
    if (!isReadonly) {
      let fn: Function | undefined
      // arrayInstrumentations 是数组的一些方法重写 如 push pop shift unshift includes 等方法
      if (targetIsArray && (fn = arrayInstrumentations[key])) {
        return fn // 如果访问的是数组方法，返回重写后的方法
      }
      // 原有的 hasOwnProperty 是检查对象自身是否具有某些属性
      // 这里重写是为了添加依赖追踪，处理原始对象和代理对象的关系
      if (key === 'hasOwnProperty') {
        return hasOwnProperty
      }
    }

    const res = Reflect.get(
      target,
      key,
      // 如果这是一个包装ref的代理，返回使用原始ref的方法
      // 作为接收者，这样我们就不需要在ref中调用 toRaw 的方法
      isRef(target) ? target : receiver,
    )

    // 处理一些特殊的，不需要进行依赖追踪的属性 例如 Symbol.iterator Symbol.toStringTag Symbol.toPrimitive 等等
    // vue内部的私有属性 __proto__,__v_isRef,__isVue
    // 这些属性根本不需要进行依赖跟踪 提高性能
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    // 如果不是只读的话，进行依赖收集
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }

    if (isShallow) {
      return res
    }

    if (isRef(res)) {
      // 用解包 - 跳过对数组和整数键的解包操作。
      return targetIsArray && isIntegerKey(key) ? res : res.value
    }

    if (isObject(res)) {
      // 同样将返回值转换为代理。我们会进行是否为对象的检查。
      // 在这里避免无效值警告。还需要惰性访问只读属性。
      // 并且在这里使用响应式（reactive）以避免循环依赖。
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

class MutableReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(false, isShallow)
  }

  /**
   * 设置代理对象的属性值
   * @param target 目标对象
   * @param key 属性名
   * @param value 属性值
   */
  set(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
    value: unknown,
    receiver: object,
  ): boolean {
    let oldValue = target[key]
    if (!this._isShallow) {
      const isOldValueReadonly = isReadonly(oldValue)
      if (!isShallow(value) && !isReadonly(value)) {
        oldValue = toRaw(oldValue)
        value = toRaw(value)
      }
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        if (isOldValueReadonly) {
          return false
        } else {
          oldValue.value = value
          return true
        }
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    const result = Reflect.set(
      target,
      key,
      value,
      isRef(target) ? target : receiver,
    )
    // don't trigger if target is something up in the prototype chain of original
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }

  /**
   * 删除代理对象的属性
   * @param target 目标对象
   * @param key 属性名
   * @returns 是否删除成功
   */
  deleteProperty(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
  ): boolean {
    const hadKey = hasOwn(target, key)
    const oldValue = target[key]
    const result = Reflect.deleteProperty(target, key)
    if (result && hadKey) {
      trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
    }
    return result
  }

  // 检查属性是否存在 也就是 in 操作符的实现
  has(target: Record<string | symbol, unknown>, key: string | symbol): boolean {
    const result = Reflect.has(target, key)
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      track(target, TrackOpTypes.HAS, key)
    }
    return result
  }

  /**
   * 获取代理对象的属性名
   * @param target 目标对象
   * @returns 属性名
   */
  ownKeys(target: Record<string | symbol, unknown>): (string | symbol)[] {
    track(
      target,
      TrackOpTypes.ITERATE,
      isArray(target) ? 'length' : ITERATE_KEY,
    )
    // 获取对象自身所有属性的实现
    return Reflect.ownKeys(target)
  }
}

/**
 * 制度响应式代码处理
 */
class ReadonlyReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(true, isShallow)
  }

  set(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }

  deleteProperty(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }
}

/**
 * 可变响应式对象的处理器
 */
export const mutableHandlers: ProxyHandler<object> =
  /*@__PURE__*/ new MutableReactiveHandler()

/**
 * 只读响应式对象的处理器
 */
export const readonlyHandlers: ProxyHandler<object> =
  /*@__PURE__*/ new ReadonlyReactiveHandler()

/**
 * 浅层可变响应式对象的处理器
 */
export const shallowReactiveHandlers: MutableReactiveHandler =
  /*@__PURE__*/ new MutableReactiveHandler(true)

/**
 * 浅层只读响应式对象的处理器
 */
export const shallowReadonlyHandlers: ReadonlyReactiveHandler =
  /*@__PURE__*/ new ReadonlyReactiveHandler(true)
