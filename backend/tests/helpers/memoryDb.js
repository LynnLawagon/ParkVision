function memoryDb(tables) {
  return { from(table) {
    let operation = 'select', values, single = false;
    const filters = [];
    const query = {
      select() { return query; }, eq(key, value) { filters.push(row => row[key] === value); return query; },
      single() { single = true; return query; }, maybeSingle() { single = true; return query; },
      insert(data) { operation = 'insert'; values = data; return query; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        tables[table] ||= [];
        if (operation === 'insert') tables[table].push(...(Array.isArray(values) ? values : [values]));
        const rows = tables[table].filter(row => filters.every(filter => filter(row)));
        return { data: single ? rows[0] || null : rows, error: null };
      }).then(resolve, reject); },
    };
    return query;
  } };
}
module.exports = { memoryDb };
