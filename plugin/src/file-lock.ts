/**
 * 每文件互斥锁（串行队列）。
 *
 * 纯模块：不 import obsidian，可直接被 Node 单测引用。
 */

type Task<T> = () => Promise<T>;

export class FileLock {
  private queues = new Map<string, Promise<unknown>>();

  /**
   * 同一 key 的任务严格串行；不同 key 互不阻塞。
   * 前一个任务失败不会影响后续排队任务。
   */
  run<T>(key: string, fn: Task<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(
      () => fn(),
      () => fn(),
    );
    // 队列槽位永远不 reject，避免一次失败卡死后续
    this.queues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** 队列长度（诊断用） */
  size(key: string): number {
    return this.queues.has(key) ? 1 : 0;
  }
}
