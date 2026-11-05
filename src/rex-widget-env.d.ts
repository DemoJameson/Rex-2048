/// <reference types='@rexnow/libs/env' />
declare namespace Rex2048Live {
    interface GlobalParams {
        /**
         * 服务端地址
         * @default 'http://127.0.0.1:18081'
         */
        server: string;
        /**
         * 界面语言
         * @default 'zh-Hans'
         */
        language: 'zh-Hans' | 'en' | 'zh-Hant';
    }
}

//#region play2048
/** Params of 2048 */
interface LoadListParams extends Rex2048Live.GlobalParams {
}

/** Return Type of 2048 */
interface LoadListReturnType extends Array<VideoItem> {
}

/**
 * 2048
 * @description 打开后使用播放器内的选集面板操作
 */
declare let loadList: (params: LoadListParams) => LoadListReturnType | null | Promise<LoadListReturnType | null>;
//#endregion play2048

//#region loadResource
/** Params of 加载播放资源 */
interface LoadResourceParams extends Rex2048Live.GlobalParams, BaseParams {
}

/** Return Type of 加载播放资源 */
interface LoadResourceReturnType extends Array<StreamSourceItem> {
}

/** 加载播放资源 */
declare let loadResource: (params: LoadResourceParams) => LoadResourceReturnType | null | Promise<LoadResourceReturnType | null>;
//#endregion loadResource
