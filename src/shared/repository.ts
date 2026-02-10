export interface Repository<TEntity> {
  get(): Promise<TEntity>;
  save(entity: TEntity): Promise<void>;
}
