import { div } from './utils';
import { dfx } from './dfx';
import type {
    ContentInfo, ResultType, ResultOkType, UidType,
} from './dfx/dfx.did.d';
import {
    CanisterAddAssetChunkResponseType,
    CanisterErrorResponseType,
    ICanisterAddChunkPayload,
    ICanisterFetchChunkPayload,
    CanisterFetchAssetChunkResponseType,
} from './impl/types';
import CanisterWorker from './impl/canisterWorker';
import {
    GenericObjType, JsonObjectType, isDef, MAX_HARDWARE_CONCURRENCY,
} from './basic';
import { ItemCompletionCallbackType } from './types';

const {
    commitAssetChunk, deleteAsset: deleteAssetFromCanister, fetchAssetInfo, initiateAssetUpload,
} = dfx;

export type AcceptableType = GenericObjType | string | {} | Blob;
export type UIDType = string;
export type Type = 'string' | 'blob' | 'json' | 'generic';
export type TypeMapping<T extends Type, R = unknown> = T extends 'string' ? string : (T extends 'blob' ? Blob : T extends 'json' ? JsonObjectType : R);

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const CHUNK_SIZE = 1.5 * 1024 * 1024; // 1.5MB

const constructWorkerPool = (len: number): CanisterWorker[] => {
    const res = Array<CanisterWorker>(len);
    for (let i = 0; i < len; i += 1) {
        res[i] = new CanisterWorker(i);
    }
    return res;
};

const CANISTER_WORKER_POOL = constructWorkerPool(MAX_HARDWARE_CONCURRENCY);

const CUSTOM_STRING_MIME_TYPE = 'amt:string' as const;

export const normalizePayload = async (data: AcceptableType): Promise<{ blob: number[], type: string }> => {
    const buffer = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : TEXT_ENCODER.encode(JSON.stringify(data));
    const type = data instanceof Blob ? data.type : CUSTOM_STRING_MIME_TYPE;
    return {
        blob: [...buffer],
        type,
    };
};

export const parse = (data: { blob: number[], type: string }): AcceptableType => {
    if (data.type !== CUSTOM_STRING_MIME_TYPE) {
        return new Blob([new Uint8Array(data.blob)], { type: data.type });
    }
    const temp = new Uint8Array(data.blob);
    return JSON.parse(TEXT_DECODER.decode(temp));
};

export const handelCanisterErr = <V extends ResultOkType>(val: ResultType<V>): val is { ok: V } => {
    if ('err' in val) {
        const messgae = Object.entries(val.err)[0];
        if (isDef(messgae)) {
            throw new Error(`${messgae[0]}("${messgae[1]}")`);
        }
        throw new Error('unknown error occured in the canister!');
    }
    return true;
};

const addAssetChunkThroughWorker = async <R = CanisterAddAssetChunkResponseType['result']>(
    workerId: number,
    payload: ICanisterAddChunkPayload,
    unwrapper?: (resp: CanisterAddAssetChunkResponseType | CanisterErrorResponseType) => R,
) => {
    const worker = CANISTER_WORKER_POOL[workerId];
    const res = await worker.submitTask('addAssetChunk', payload);
    const callback = unwrapper || ((resp) => {
        if ('error' in resp) throw new Error(resp.error.message);
        return resp.result;
    });
    return callback(res) as R;
};

const fetchAssetChunkThroughWorker = async <R = CanisterFetchAssetChunkResponseType['result']>(
    workerId: number,
    payload: ICanisterFetchChunkPayload,
    unwrapper?: (resp: CanisterFetchAssetChunkResponseType | CanisterErrorResponseType) => R,
) => {
    const worker = CANISTER_WORKER_POOL[workerId];
    const res = await worker.submitTask('fetchAssetChunk', payload);
    const callback = unwrapper || ((resp) => {
        if ('error' in resp) throw new Error(resp.error.message);
        return resp.result;
    });
    return callback(res) as R;
};

export const storeAssets = async (
    uid: UIDType,
    name: string,
    payload: AcceptableType,
    overwrite = false,
    sizeCallback = (size: number) => { },
) => {
    const { blob, type } = await normalizePayload(payload);
    const len = blob.length;
    const { q, r } = div(len, CHUNK_SIZE);
    const chunks = q + (r === 0 ? 0 : 1);
    sizeCallback(len);
    const info: ContentInfo = {
        uid,
        name,
        size: BigInt(len),
        totalChunks: BigInt(chunks),
        dtype: type,
    };

    const initErr = await initiateAssetUpload(info, [overwrite]);
    handelCanisterErr(initErr);

    const promises: Promise<void>[] = [];
    for (let i = 0, j = 0; i < len; i += CHUNK_SIZE, j += 1) {
        const ib = Math.min(CHUNK_SIZE, len - i);
        const chunk = blob.slice(i, i + ib);
        const workerId = j % CANISTER_WORKER_POOL.length;
        const temp: ICanisterAddChunkPayload = {
            chunk: {
                chunk,
                chunkId: BigInt(j),
            },
            uid,
        };
        promises.push(addAssetChunkThroughWorker(workerId, temp, (resp) => {
            if ('error' in resp) throw new Error(resp.error.message);
        }));
    }

    // TODO: Handle Failure
    await Promise.all(promises);

    const commitErr = await commitAssetChunk(uid);
    handelCanisterErr(commitErr);
};

export const storeAssetsBatch = async (
    assets: { uid: UIDType, name: string, payload: AcceptableType }[],
    overwrite = false,
    itemCompletionCallback: ItemCompletionCallbackType = () => { },
) => {
    const promises = [] as Promise<void>[];
    const set = new Set<UIDType>();
    itemCompletionCallback({ type: 'itemEstimation', items: assets.length });
    assets.forEach((asset) => {
        if (set.has(asset.uid)) {
            itemCompletionCallback({ type: 'progress', item: { uid: asset.uid, name: asset.name } });
            return;
        }
        set.add(asset.uid);
        const fn = async () => {
            await storeAssets(asset.uid, asset.name, asset.payload, overwrite);
            itemCompletionCallback({ type: 'progress', item: { uid: asset.uid, name: asset.name } });
        };
        promises.push(fn());
    });
    try {
        await Promise.all(promises);
    } catch (e) {
        // TODO: Handle failure case
        console.warn(e);
    }
};

export const fetchAsset = async (uid: UIDType): Promise<{ info: ContentInfo, payload: AcceptableType }> => {
    const infoErr = await fetchAssetInfo(uid);
    handelCanisterErr(infoErr);

    const { ok: info } = infoErr as { ok: ContentInfo };

    const { totalChunks, dtype: type } = info;
    const promises: Promise<void>[] = [];
    const chunks = Array<number[]>(Number(totalChunks));

    for (let chunkId = BigInt(0), j = 0; chunkId < totalChunks; chunkId += 1n, j += 1) {
        const workerId = j % CANISTER_WORKER_POOL.length;
        promises.push(fetchAssetChunkThroughWorker(workerId, { chunkId, uid }, (resp) => {
            if ('error' in resp) throw new Error(resp.error.message);
            chunks[Number(chunkId)] = [...resp.result.chunk.chunk];
        }));
    }

    await Promise.all(promises);

    const flatenedArray = chunks.flat();
    return { info, payload: parse({ blob: flatenedArray, type }) };
};

export const fetchAssetBatch = async (
    uids: UIDType[],
    itemCompletionCallback: ItemCompletionCallbackType = () => { },
): Promise<Record<UidType, AcceptableType>> => {
    const promises = [] as Promise<void>[];
    const res = {} as Record<UidType, AcceptableType>;
    const set = new Set<UIDType>();
    itemCompletionCallback({ type: 'itemEstimation', items: uids.length });
    uids.forEach((uid) => {
        if (set.has(uid)) {
            itemCompletionCallback({ type: 'progress', item: { uid } });
            return;
        }
        set.add(uid);
        const runFn = async () => {
            const { info, payload } = await fetchAsset(uid);
            res[uid] = payload;
            itemCompletionCallback({ type: 'progress', item: { uid, name: info.name } });
        };
        promises.push(runFn());
    });
    return res;
};

export const deleteAsset = async (uid: UIDType): Promise<Error | undefined> => {
    const resultOr = await deleteAssetFromCanister(uid);
    try {
        handelCanisterErr(resultOr);
        return undefined;
    } catch (e) {
        return e as Error;
    }
};
