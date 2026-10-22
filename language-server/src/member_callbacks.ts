import * as db from './database';

export function callbackError(delegate: db.DBType, method: db.DBMethod, owner: db.DBType): string | null {
    if (!delegate?.isDelegate || !delegate.isUnrealType() || delegate.isEvent || delegate.delegateReturn != 'void')
        return '成员回调要求受支持的原生 void 委托或事件订阅参数';
    if (!delegate.delegateArgs || delegate.delegateArgs.some(arg => arg.typename.includes('&')))
        return '成员回调仅支持值输入参数，不支持引用、输出参数或通配参数';
    if (!method || method.containingType != owner || !method.declaredModule)
        return '回调方法必须由当前脚本类声明';
    if (owner.findSymbols(method.name).filter(symbol => symbol instanceof db.DBMethod).length != 1)
        return '回调方法不能重载';
    if (!method.isUFunction) return '回调方法必须显式声明 UFUNCTION()';
    if (method.isBlueprintEvent || method.isBlueprintOverride
        || ['Server', 'Client', 'NetMulticast', 'BlueprintOverride', 'BlueprintEvent'].some(flag => method.macroSpecifiers?.has(flag)))
        return '蓝图事件、覆写和 RPC 不能作为成员回调';
    if (method.returnType != 'void') return '回调方法必须返回 void';
    if (method.args.length > delegate.delegateArgs.length) return '回调参数必须是委托签名的前缀';
    for (let index = 0; index < method.args.length; ++index) {
        const actual = method.args[index].typename;
        const expected = delegate.delegateArgs[index].typename;
        if (actual.includes('&') || (db.CleanTypeName(actual) != db.CleanTypeName(expected)
            && !db.ArePrimitiveTypesEquivalent(db.CleanTypeName(actual), db.CleanTypeName(expected))))
            return '回调参数必须按顺序精确匹配委托前缀，不支持类型转换或引用参数';
    }
    return null;
}

export function callbackDescription(delegate: db.DBType, method: db.DBMethod): string {
    return `成员回调：接收前 ${method.args.length}/${delegate.delegateArgs.length} 个参数。\n\n${isMulticastCallback(delegate) ? '原生多播事件' : '委托'}：\`${delegate.delegateReturn} ${callbackDisplayName(delegate)}(${delegate.delegateArgs.map(arg => arg.format()).join(', ')})\``;
}

export function isMulticastCallback(delegate: db.DBType): boolean {
    return delegate?.name.startsWith('__ASMulticastCallback_') ?? false;
}

export function callbackDisplayName(delegate: db.DBType): string {
    return isMulticastCallback(delegate) ? delegate.name.slice('__ASMulticastCallback_'.length) : delegate.name;
}
