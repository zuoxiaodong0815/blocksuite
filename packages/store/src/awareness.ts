import * as Y from 'yjs';
import type { RelativePosition } from 'yjs';
import type { Awareness } from 'y-protocols/awareness.js';
import type { Space } from './space';
import { Signal } from './utils/signal';

export interface SelectionRange {
  id: string;
  anchor: RelativePosition;
  focus: RelativePosition;
}

interface UserInfo {
  id: number;
  name: string;
  color: string;
}

interface BlockSelection {
  type: 'none' | 'cursor' | 'all' | 'range';
  anchor: RelativePosition;
  focus: RelativePosition;
}

export interface SelectionRangeInfo {
  [key: string]: BlockSelection;
}

interface AwarenessState {
  select?: SelectionRangeInfo;
  user: UserInfo;
}

interface AwarenessMessage {
  id: number;
  type: 'add' | 'update' | 'remove';
  state?: AwarenessState;
}

export class AwarenessAdapter {
  readonly space: Space;
  readonly awareness: Awareness;

  readonly signals = {
    update: new Signal<AwarenessMessage>(),
  };

  private _selectionRanges: { [id: string]: AwarenessState } = {};

  constructor(space: Space, awareness: Awareness) {
    this.space = space;
    this.awareness = awareness;
    this.awareness.on('change', this._onAwarenessChange);
    this.signals.update.on(this._onAwarenessMessage);
  }

  public setLocalCursor(range: SelectionRange) {
    const select: SelectionRangeInfo = {
      [range.id]: {
        type: 'cursor',
        anchor: range.anchor,
        focus: range.focus,
      },
    };
    this.awareness.setLocalStateField('select', select);
  }

  public getLocalCursor(): SelectionRange | undefined {
    const states = this.awareness.getStates();
    const awarenessState = states.get(this.awareness.clientID);
    const select = awarenessState?.select as SelectionRangeInfo;
    if (select) {
      const id = Object.keys(select)[0];
      return {
        id,
        ...select[id],
      };
    }
    return undefined;
  }

  public getStates(): Map<number, AwarenessState> {
    return this.awareness.getStates() as Map<number, AwarenessState>;
  }

  private _onAwarenessChange = (diff: {
    added: number[];
    removed: number[];
    updated: number[];
  }) => {
    const { added, removed, updated } = diff;

    const states = this.awareness.getStates();
    added.forEach(id => {
      this.signals.update.emit({
        id,
        type: 'add',
        state: states.get(id) as AwarenessState,
      });
    });
    updated.forEach(id => {
      this.signals.update.emit({
        id,
        type: 'update',
        state: states.get(id) as AwarenessState,
      });
    });
    removed.forEach(id => {
      this.signals.update.emit({
        id,
        type: 'remove',
      });
    });
  };

  private _onAwarenessMessage = (awMsg: AwarenessMessage) => {
    if (awMsg.id === this.awareness.clientID) {
      this.updateLocalCursor();
    } else {
      this._resetRemoteCursor(
        awMsg.id,
        awMsg.state,
        this._selectionRanges[awMsg.id]
      );
    }

    if (awMsg.state) {
      this._selectionRanges[awMsg.id] = awMsg.state;
    } else {
      delete this._selectionRanges[awMsg.id];
    }
  };

  private _resetRemoteCursor(
    clientId: number,
    awState: AwarenessState | undefined,
    oldAwState: AwarenessState | undefined
  ) {
    const update = Object.keys(oldAwState?.select || {});
    update.push(...Object.keys(awState?.select || {}));
    new Set(update).forEach(blockId => {
      this._updateRemoteCursor(clientId, blockId, awState);
    });
  }

  private _updateRemoteCursor(
    clientId: number,
    blockId: string,
    awState: AwarenessState | undefined
  ) {
    const textAdapter = this.space.richTextAdapters.get(blockId);
    if (!textAdapter) {
      return;
    }
    const select: BlockSelection = (awState?.select || {})[blockId];
    if (!awState || !select) {
      textAdapter?.quillCursors.removeCursor(clientId.toString());
      return;
    }
    const anchor = Y.createAbsolutePositionFromRelativePosition(
      select.anchor,
      this.space.doc
    );
    const focus = Y.createAbsolutePositionFromRelativePosition(
      select.focus,
      this.space.doc
    );
    if (anchor && focus && textAdapter) {
      const user = awState.user || {};
      const color = user.color || '#ffa500';
      const name = user.name || 'other';
      textAdapter.quillCursors.createCursor(clientId.toString(), name, color);
      textAdapter.quillCursors.moveCursor(clientId.toString(), {
        index: anchor.index,
        length: focus.index - anchor.index,
      });
    }
  }

  public updateLocalCursor() {
    const localCursor = this.space.awareness.getLocalCursor();
    if (!localCursor) {
      return;
    }
    const anchor = Y.createAbsolutePositionFromRelativePosition(
      localCursor.anchor,
      this.space.doc
    );
    const focus = Y.createAbsolutePositionFromRelativePosition(
      localCursor.focus,
      this.space.doc
    );
    if (anchor && focus) {
      const textAdapter = this.space.richTextAdapters.get(localCursor.id || '');
      textAdapter?.quill.setSelection(anchor.index, focus.index - anchor.index);
    }
  }

  public updateRemoteSelect(blockId: string) {
    this.getStates().forEach((awState, clientId) => {
      if (clientId !== this.awareness.clientID) {
        this._updateRemoteCursor(clientId, blockId, awState);
      }
    });
  }

  destroy() {
    if (this.awareness) {
      this.awareness.off('change', this._onAwarenessChange);
      this.signals.update.dispose();
    }
  }
}
