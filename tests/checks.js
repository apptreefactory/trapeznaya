(() => {
  const results = [];
  const compatibility = {name: 'Проект для версии 2', people: 87};
  const vatText = 'в том числе НДС 22 %';
  const decode = value => new TextDecoder().decode(Uint8Array.from(atob(value), c => c.charCodeAt(0)));
  const el = selector => document.querySelector(selector);

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function click(selector) {
    const button = el(selector);
    assert(button, 'Не найден элемент ' + selector);
    button.click();
  }

  function change(selector, value) {
    const input = el(selector);
    assert(input, 'Не найдено поле ' + selector);
    input.value = String(value);
    // Обработчик фиксации числа сам отправляет событие input.
    input.dispatchEvent(new Event('change', {bubbles: true}));
  }

  async function waitFor(check, message) {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(check(), message);
  }

  async function newProject(name, people = 60) {
    const previous = S.pid;
    await createProject(blankProject(name, people));
    assert(S.pid && S.pid !== previous && S.name === name, 'Проект не открылся');
  }

  async function test(id, name, check) {
    try {
      await check();
      results.push({id, name, passed: true});
    } catch (error) {
      results.push({id, name, passed: false, note: error.message || String(error)});
    }
  }

  function validateImport(text) {
    validateProjectImport(JSON.parse(text));
    const parsed = parseProjectText(text);
    assert(!parsed.error, parsed.error);
    return parsed.data;
  }

  async function run() {
    localStorage.clear();
    if (window.__CHECK_MODE === 'v2') {
      await test(7, 'Совместимость с версией 2', () => {
        assert(window.__CHECK_PROJECT, decode(window.__CHECK_PROJECT_ERROR) || 'Нет сохранённого проекта');
        const data = JSON.parse(decode(window.__CHECK_PROJECT));
        assert(data.v === 2 && data.norms.vat === 22, 'В сохранённом проекте нет версии 2 или НДС 22 %');
        const opened = migrate(data);
        assert(opened && opened.name === compatibility.name && opened.people === compatibility.people,
          'Версия 2 не открыла проект или потеряла имя или число людей');
      });
      return {results};
    }

    // В этой странице одна вкладка. Виртуальные часы Edge могут закончиться, пока браузер ждёт Web Locks.
    // Сохраняем обычную запись в localStorage и выполняем операции под блокировкой в очереди страницы.
    let storageQueue = Promise.resolve();
    STORE.locked = callback => {
      const next = storageQueue.then(callback);
      storageQueue = next.catch(() => {});
      return next;
    };

    await test(1, 'Пример без ошибок', async () => {
      click('[data-pa="example"]');
      await waitFor(() => S.pid && S.name === 'Пример — трапезная воскресной школы' && !el('#pj-screen'), 'Пример не открылся');
      click('#steps [data-step="5"]');
      await waitFor(() => step === 5 && S.layoutSig && Object.keys(S.layout).length, 'Авторасстановка не завершилась');
      const issues = stepIss();
      const bad = issues.reduce((total, issue) => total + issue.bad, 0);
      const warn = issues.reduce((total, issue) => total + issue.warn, 0);
      const details = issues.flatMap(issue => issue.list.map(item => item.m)).join(' | ');
      assert(bad === 0 && warn === 0, 'Ошибок ' + bad + ', предупреждений ' + warn + '. ' + details);
    });

    await test(2, 'Электроснабжение на шаге Подключения', async () => {
      await newProject('Проверка электроснабжения');
      const fields = ['#kw', '#kwmax', '[data-seg="ph"]', '[data-seg="phMax"]'];
      assert(step === 0 && fields.every(selector => !el(selector)), 'Поля мощности остались на шаге «Исходные»');
      click('#steps [data-step="2"]');
      assert(step === 2 && fields.slice(0, 3).every(selector => el(selector)), 'Поля мощности отсутствуют на шаге «Подключения»');
      change('#kw', 30);
      change('#kwmax', 20);
      assert(el('#kwmax').getAttribute('aria-invalid') === 'true', 'Поле максимальной мощности не отмечено как ошибочное');
      const issues = stepIss();
      const message = '«Можно увеличить до» меньше, чем выделено сейчас';
      assert(issues[2].bad >= 1 && issues[2].list.some(item => item.m.includes(message)), 'На шаге «Подключения» нет замечания о мощности');
      assert(!issues[0].list.some(item => item.m.includes(message)), 'Замечание о мощности осталось на шаге «Исходные»');
      await waitFor(() => el('[data-seg="phMax"]'), 'Поле ввода после увеличения не появилось');
    });

    await test(3, 'Газ в одном месте', async () => {
      await newProject('Проверка газа');
      assert(!el('#gas-on, [data-seg="gas-src"]') && main.textContent.includes('Газ: неизвестно'), 'На шаге «Исходные» неверный блок газа');
      const link = el('button[data-go="2"]');
      assert(link && link.textContent === 'Изменить на шаге «Подключения»', 'Нет кнопки изменения газа');
      link.click();
      assert(step === 2, 'Кнопка не переключила на шаг «Подключения»');
      for (const [value, label] of [['have', 'Есть'], ['none', 'Нет'], ['unk', 'Неизвестно']]) {
        const selector = '[data-seg="net-gas"] [data-v="' + value + '"]';
        assert(el(selector)?.textContent === label, 'Нет варианта «' + label + '»');
        click(selector);
        const have = value === 'have';
        assert(S.nets.gas === value && S.gas.on === have && !!el('[data-seg="gas-src"]') === have,
          'Неверные данные или поля газа для варианта «' + label + '»');
        if (have) {
          click('[data-seg="gas-src"] [data-v="bottle"]');
          assert(S.gas.src === 'bottle', 'Источник газа не сохранился');
          go(0);
          assert(main.textContent.includes('Газ: есть, баллоны'), 'Не показан выбранный источник газа');
          go(2);
        }
      }
    });

    await test(4, 'Перенос газа из старых проектов', () => {
      for (const [on, oldNet, net, expectedOn] of [
        [true, 'unk', 'have', true], [true, 'none', 'have', true],
        [false, 'have', 'have', true], [false, 'unk', 'unk', false]
      ]) {
        const data = blankProject('Старые настройки газа', 60);
        data.gas = {on, src: 'bottle'};
        data.nets.gas = oldNet;
        const opened = migrate(data);
        assert(opened && opened.nets.gas === net && opened.gas.on === expectedOn && opened.gas.src === 'bottle',
          'Ошибка переноса газа для ' + on + '/' + oldNet);
      }
      const oldV1 = migrate({v: 1, people: 60, gas: {on: true, src: 'bottle'}, nets: {gas: 'none'}});
      assert(oldV1 && oldV1.nets.gas === 'have' && oldV1.gas.on === true && oldV1.gas.src === 'bottle', 'Ошибка переноса газа из формата 1');
    });

    await test(5, 'НДС в смете', async () => {
      await newProject('Проверка НДС');
      assert(S.norms.vat === 22, 'У нового проекта нет ставки 22 %');
      const legacy = blankProject('Смета старого проекта', 60);
      delete legacy.norms.vat;
      assert(migrate(legacy).norms.vat === 22, 'После переноса старого проекта нет ставки 22 %');
      go(7);
      const C = costCalc();
      assert(C.total > 0 && C.vatRate === 22 && C.vat === Math.round(C.total * 22 / 122 * 100) / 100, 'Неверная сумма НДС');
      const vatRow = () => el('.sum-line.total').nextElementSibling;
      assert(vatRow().textContent.includes(vatText) && vatRow().textContent.includes(rub(C.vat, 2)), 'В смете нет строки или суммы НДС');
      click('#set-open');
      const input = el('#n-vat');
      assert(input && input.value === '22' && input.getAttribute('step') === '1' && input.getAttribute('min') === '0' &&
        input.getAttribute('max') === '30' && input.closest('label').textContent.includes('Цены вводятся с НДС, как их дают поставщики'),
        'В настройках нет ставки НДС с нужным диапазоном и подсказкой');
      try {
        change('#n-vat', 31);
        assert(S.norms.vat === 22 && input.getAttribute('aria-invalid') === 'true', 'Применилось значение НДС вне диапазона');
        change('#n-vat', 0);
        await waitFor(() => vatRow().textContent.includes('НДС не облагается'), 'Нет строки для нулевой ставки НДС');
        assert(!vatRow().querySelector('.num'), 'При нулевой ставке показана сумма НДС');
      } finally {
        click('#set-x');
      }
    });

    await test(6, 'НДС в PDF и копии', async () => {
      await newProject('Проверка НДС в PDF и копии');
      go(7);
      const C = costCalc();
      const table = REPORT.get('cost').build({pos: positions()}).find(block => block.t === 'table');
      const [total, vat] = table.foot.slice(-2);
      assert(total[1] === 'Итого' && vat[1] === vatText && vat[4] === fmt2(C.vat), 'В данных PDF нет строки или суммы НДС после итога');
      let copied;
      const originalCopy = copyText;
      try {
        copyText = text => { copied = text; };
        click('#cp-tbl');
      } finally {
        copyText = originalCopy;
      }
      const [totalLine, vatLine] = copied.split('\n').slice(-2).map(line => line.split('\t'));
      assert(totalLine[0] === 'Итого' && vatLine[0] === vatText && Number(vatLine[5].replace(',', '.')) === C.vat,
        'В копии спецификации нет строки или суммы НДС после итога');
    });

    let project = '';
    let compatibilityError = '';
    try {
      await newProject(compatibility.name, compatibility.people);
      project = STORE.raw(S.pid);
      assert(project, 'В хранилище нет сохранённого проекта');
    } catch (error) {
      compatibilityError = error.message || String(error);
    }

    await test(8, 'Импорт файла без НДС', async () => {
      const legacy = blankProject('Импорт прежнего проекта', 71);
      legacy.norms.vat = 18;
      assert(validateImport(JSON.stringify(legacy)).norms.vat === 18, 'Файл с НДС не сохранил ставку');
      delete legacy.norms.vat;
      const oldText = JSON.stringify(legacy);
      assert(validateImport(oldText).norms.vat === 22, 'При чтении файла без НДС не добавилась ставка 22 %');
      importProjectText(oldText, 'старый-проект.json');
      click('#pj-open');
      await waitFor(() => S.name === legacy.name, 'Импортированный проект не открылся');
      assert(S.norms.vat === 22, 'У открытого проекта нет ставки 22 %');
    });

    return {results, project, compatibilityError};
  }

  function publish(output) {
    const pre = document.createElement('pre');
    pre.id = 'test-results';
    pre.hidden = true;
    pre.textContent = JSON.stringify(output);
    document.body.appendChild(pre);
  }

  run().then(publish, error => publish({fatal: error.message || String(error)}));
})();
