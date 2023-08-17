import { BlockService } from '@blocksuite/block-std';
import { assertExists } from '@blocksuite/global/utils';
import { type BaseBlockModel, type Page } from '@blocksuite/store';

import { getService } from '../__internal__/service/index.js';
import { BaseService } from '../__internal__/service/service.js';
import type { BlockModels } from '../__internal__/utils/model.js';
import type {
  BlockTransformContext,
  SerializedBlock,
} from '../__internal__/utils/types.js';
import type { DataViewDataType, DataViewTypes } from './common/data-view.js';
import { DatabaseSelection } from './common/selection.js';
import type { DatabaseBlockModel } from './database-model.js';
import type { Column } from './table/types.js';
import type { Cell } from './types.js';

export class LegacyDatabaseBlockService extends BaseService<DatabaseBlockModel> {
  initDatabaseBlock(
    page: Page,
    model: BaseBlockModel,
    databaseId: string,
    viewType: DataViewTypes,
    isAppendNewRow = true
  ) {
    const blockModel = page.getBlockById(databaseId) as DatabaseBlockModel;
    assertExists(blockModel);
    blockModel.initTemplate(viewType);
    if (isAppendNewRow) {
      // Add a paragraph after database
      const parent = page.getParent(model);
      assertExists(parent);
      page.addBlock('affine:paragraph', {}, parent.id);
    }
    blockModel.applyColumnUpdate();
  }

  override block2Json(block: BlockModels['affine:database']): SerializedBlock {
    const columns = [...block.columns];
    const rowIds = block.children.map(child => child.id);

    const children = block.children?.map(child => {
      return getService(child.flavour).block2Json(child);
    });

    return {
      flavour: block.flavour,
      databaseProps: {
        id: block.id,
        title: block.title.toString(),
        rowIds,
        cells: block.cells,
        columns,
        views: block.views,
      },
      children,
    };
  }

  override async onBlockPasted(
    model: BlockModels['affine:database'],
    props: {
      rowIds: string[];
      columns: Column[];
      cells: Record<string, Record<string, Cell>>;
      views: DataViewDataType[];
    }
  ) {
    const { rowIds, columns, cells, views } = props;
    const columnIds = columns.map(column => column.id);
    model.deleteColumn(model.id);
    const newColumnIds = columns.map(schema => {
      const { id, ...nonIdProps } = schema;
      return model.addColumn('end', nonIdProps);
    });
    model.applyColumnUpdate();

    const newRowIds = model.children.map(child => child.id);
    rowIds.forEach((rowId, rowIndex) => {
      const newRowId = newRowIds[rowIndex];
      columnIds.forEach((columnId, columnIndex) => {
        const cellData = cells[rowId]?.[columnId];
        const value = cellData?.value;
        if (!value) return;
        model.updateCell(newRowId, {
          columnId: newColumnIds[columnIndex],
          value,
        });
      });
    });

    views.forEach(view => {
      model.addView(view.mode);
    });
  }

  override async block2html(
    block: BlockModels['affine:database'],
    { childText = '', begin, end }: BlockTransformContext = {},
    blobMap?: Map<string, string>
  ): Promise<string> {
    // const rows = block.children.map(v => v.id);
    // const view = block.views;;
    // const columns = view.columns;
    // // const columns = block.columns;
    // columns.map(column => {
    //   const { id, name } = column;
    //   column.getValue
    // });

    // const dd = rows.map(row => {
    //   const cells = block.cells[row];
    //   columns.map(column => {
    //     const cell = cells[column.id];
    //     if (cell) {
    //       const value = cell.value;
    //       if (value) {
    //         const text = value.toString();
    //         if (text) {
    //           childText += text;
    //         }
    //       }
    //     }
    //   });
    // });

    const text = `
<div id="0b55370f-1b24-4124-9d6f-725ce7ea296f" class="collection-content">
	<h4 class="collection-title">${block.title.toString()}</h4>
	<table class="collection-content">
		<thead>
			<tr>
        ${block.columns
          .map(column => {
            return `<th>${column.name}</th>
          <th>`;
          })
          .join('\n')}
			</tr>
		</thead>
		<tbody>
			<tr id="8d053be7-05c3-4a8e-a49a-9c99b1d57741">
				<td class="cell-title"><a
						href="https://www.notion.so/aaa-8d053be705c34a8ea49a9c99b1d57741?pvs=21">aaa</a></td>
				<td class="cell"><span class="selected-value select-value-color-default">bbbb</span><span
						class="selected-value select-value-color-yellow">bbbbkj</span></td>
				<td class="cell"></td>
			</tr>
			<tr id="763d7f97-9940-4f71-a956-314ae9adba67">
				<td class="cell-title"><a
						href="https://www.notion.so/ccccc-763d7f9799404f71a956314ae9adba67?pvs=21">ccccc</a></td>
				<td class="cell"></td>
				<td class="cell"></td>
			</tr>
			<tr id="85fdc7c7-3e89-4c3a-8aa9-86341f43c280">
				<td class="cell-title"><a
						href="https://www.notion.so/85fdc7c73e894c3a8aa986341f43c280?pvs=21">Untitled</a></td>
				<td class="cell"></td>
				<td class="cell"></td>
			</tr>
		</tbody>
	</table><br><br>
</div>
    `;
    return `${text}`;
  }
}

export class DatabaseService extends BlockService<DatabaseBlockModel> {
  override mounted(): void {
    super.mounted();
    this.selectionManager.register(DatabaseSelection);

    this.handleEvent('selectionChange', () => true);
  }
}
