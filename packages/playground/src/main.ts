import '@blocksuite/blocks';
import '@blocksuite/editor';
import {
  createEditor,
  createDebugMenu,
  BlockSchema,
  EditorContainer,
} from '@blocksuite/editor';
import {
  DebugDocProvider,
  IndexedDBDocProvider,
  createWebsocketDocProvider,
  createAutoIncrementIdGenerator,
  uuidv4,
  Workspace,
} from '@blocksuite/store';
import type { DocProviderConstructor, StoreOptions } from '@blocksuite/store';

import './style.css';
import { PageBlockModel } from '@blocksuite/blocks';

const params = new URLSearchParams(location.search);
const room = params.get('room') ?? 'dfgsdfgsd';
const isTest = params.get('isTest') === 'true';
let editor: EditorContainer | null = null;

/**
 * Specified by `?syncModes=debug` or `?syncModes=indexeddb,debug`
 * Default is debug (using webrtc)
 */
function editorOptionsFromParam(): Pick<
  StoreOptions,
  'providers' | 'idGenerator'
> {
  const providers: DocProviderConstructor[] = [];

  /**
   * Specified using "uuidv4" when providers have indexeddb.
   * Because when persistent data applied to ydoc, we need generator different id for block.
   * Otherwise, the block id will conflict.
   */
  let forceUUIDv4 = false;

  const modes = (params.get('syncModes') ?? 'debug').split(',');

  modes.forEach(mode => {
    switch (mode) {
      case 'debug': {
        providers.push(DebugDocProvider);
        break;
      }
      case 'indexeddb':
        providers.push(IndexedDBDocProvider);
        forceUUIDv4 = true;
        break;
      case 'websocket': {
        const WebsocketDocProvider = createWebsocketDocProvider(
          'ws://127.0.0.1:1234'
        );
        providers.push(WebsocketDocProvider);
        forceUUIDv4 = true;
        break;
      }
      default:
        throw new TypeError(
          `Unknown provider ("${mode}") supplied in search param ?syncModes=... (for example "debug" and "indexeddb")`
        );
    }
  });

  /**
   * Specified using "uuidv4" when providers have indexeddb.
   * Because when persistent data applied to ydoc, we need generator different id for block.
   * Otherwise, the block id will conflict.
   */
  const idGenerator = forceUUIDv4 ? uuidv4 : createAutoIncrementIdGenerator();

  return {
    providers,
    idGenerator,
  };
}

function switchPage(pageId: string, workspace: Workspace) {
  const newpage =
    workspace.getPage(pageId) ||
    workspace
      .createPage<typeof BlockSchema>(pageId)
      .register(BlockSchema)
      .init();
  if (!editor) {
    editor = createEditor(newpage);
    const debugMenu = createDebugMenu(workspace, editor);
    const pagePontainer = document.getElementById('pagePontainer');
    pagePontainer?.appendChild(debugMenu);
    pagePontainer?.appendChild(editor);
  }

  editor.page = newpage;
  editor.model = newpage.getBlockByFlavour(
    'affine:page'
  )[0] as unknown as PageBlockModel;
  setTimeout(() => {
    newpage.signals.updated.emit();
    refreshPagelist(workspace);
    const pagelistEle = document.getElementById(
      'pagelist'
    ) as HTMLSelectElement;
    if (pagelistEle) {
      pagelistEle.value = pageId;
    }
  });
}

function refreshPagelist(workspace: Workspace) {
  let options = '';
  workspace.doc.getMap().forEach((value, key) => {
    options += `<option value ="${key}">${key}</option>`;
  });
  const pagelistEle = document.getElementById('pagelist');
  if (pagelistEle) {
    pagelistEle.innerHTML = options;
  }
  if (!editor && workspace.doc.getMap().size > 0) {
    switchPage(workspace.doc.getMap().keys().next().value, workspace);
  }
}

function initPageMenu(
  menuPontainer: HTMLElement,
  workspace: Workspace,
  editor: any
) {
  const titleContainer = document.createElement('button') as HTMLButtonElement;
  titleContainer.textContent = 'addPage';
  titleContainer.addEventListener('click', () => {
    const pageId = uuidv4();
    switchPage(pageId, workspace);
  });
  menuPontainer.appendChild(titleContainer);

  const selectContainer = document.createElement('select') as HTMLSelectElement;
  selectContainer.setAttribute('id', 'pagelist');
  selectContainer.addEventListener('change', () => {
    switchPage(selectContainer.value, workspace);
  });
  menuPontainer.appendChild(selectContainer);

  refreshPagelist(workspace);
  workspace.doc.on('subdocs', ({ added, removed, loaded }) => {
    refreshPagelist(workspace);
  });
}

window.onload = () => {
  const workspace = new Workspace({
    room: room,
    ...editorOptionsFromParam(),
  });
  // @ts-ignore
  window.workspace = workspace;
  // @ts-ignore
  window.blockSchema = BlockSchema;

  // In dev environment, init editor by default, but in test environment, init editor by the test page
  if (!isTest) {
    const menuPontainer = document.createElement('div');
    document.body.appendChild(menuPontainer);
    const pagePontainer = document.createElement('div');
    pagePontainer.setAttribute('id', 'pagePontainer');
    document.body.appendChild(pagePontainer);

    // const pageId = uuidv4();
    // const page = workspace
    //   .createPage<typeof BlockSchema>(pageId)
    //   .register(BlockSchema);
    // const editor = createEditor(page);
    // const debugMenu = createDebugMenu(workspace, editor);

    // pagePontainer.appendChild(debugMenu);
    // pagePontainer.appendChild(editor);

    initPageMenu(menuPontainer, workspace, editor);
  }
};
