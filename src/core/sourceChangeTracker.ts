import { fingerprintMemorySourceContents } from './memoryWarehouseRuntime';
import type { MemorySourceMessageFingerprint } from './memoryWarehouseTypes';
import type { RawChatSourceContent } from './rawChatReader';

export interface SourceChangeDiff {
  changed: boolean;
  earliestChangedFloor?: number;
  changedMessageIds: number[];
}

function sameFingerprint(
  left: MemorySourceMessageFingerprint | undefined,
  right: MemorySourceMessageFingerprint | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.messageId === right.messageId
    && left.contentHash === right.contentHash
    && left.role === right.role
    && left.swipeId === right.swipeId
    && left.metadataHash === right.metadataHash
    && left.sceneId === right.sceneId
    && left.traceId === right.traceId;
}

/** 只保存在脚本运行期，用于区分正文／消息页变化和酒馆的普通重渲染事件。 */
export class SourceChangeTracker {
  private snapshot = new Map<number, MemorySourceMessageFingerprint>();

  reset(contents: RawChatSourceContent[]): void {
    this.snapshot = new Map(
      fingerprintMemorySourceContents(contents).map(message => [message.messageId, message] as const),
    );
  }

  updateFromFloor(contents: RawChatSourceContent[], fromFloor: number): void {
    const floor = Math.max(0, Math.floor(fromFloor));
    for (const messageId of [...this.snapshot.keys()]) {
      if (messageId >= floor) this.snapshot.delete(messageId);
    }
    for (const message of fingerprintMemorySourceContents(contents)) {
      if (message.messageId >= floor) this.snapshot.set(message.messageId, message);
    }
  }

  diffAndReset(contents: RawChatSourceContent[], fromFloor: number): SourceChangeDiff {
    const floor = Math.max(0, Math.floor(fromFloor));
    const currentRange = new Map(
      fingerprintMemorySourceContents(contents)
        .filter(message => message.messageId >= floor)
        .map(message => [message.messageId, message] as const),
    );
    const ids = [...new Set([
      ...[...this.snapshot.keys()].filter(messageId => messageId >= floor),
      ...currentRange.keys(),
    ])]
      .filter(messageId => messageId >= floor)
      .sort((left, right) => left - right);
    const changedMessageIds = ids.filter(messageId => (
      !sameFingerprint(this.snapshot.get(messageId), currentRange.get(messageId))
    ));
    this.updateFromFloor(contents, floor);
    return {
      changed: changedMessageIds.length > 0,
      earliestChangedFloor: changedMessageIds[0],
      changedMessageIds,
    };
  }
}
