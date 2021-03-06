import { buildLocale, RawLocaleInfo, organizeRawLocales } from '../datelib/locale'
import { memoize, memoizeObjArg } from '../util/memoize'
import { Action } from './Action'
import { buildPluginHooks } from '../plugin-system'
import { PluginHooks } from '../plugin-system-struct'
import { DateEnv } from '../datelib/env'
import { CalendarApi } from '../CalendarApi'
import { StandardTheme } from '../theme/StandardTheme'
import { EventSourceHash } from '../structs/event-source'
import { buildViewSpecs } from '../structs/view-spec'
import { mapHash, isPropsEqual } from '../util/object'
import { DateProfileGenerator, DateProfileGeneratorProps } from '../DateProfileGenerator'
import { reduceViewType } from './view-type'
import { getInitialDate, reduceCurrentDate } from './current-date'
import { reduceDynamicOptionOverrides } from './options'
import { reduceDateProfile } from './date-profile'
import { reduceEventSources, initEventSources, reduceEventSourcesNewTimeZone, computeEventSourceLoadingLevel } from './eventSources'
import { reduceEventStore, rezoneEventStoreDates } from './eventStore'
import { reduceDateSelection } from './date-selection'
import { reduceSelectedEvent } from './selected-event'
import { reduceEventDrag } from './event-drag'
import { reduceEventResize } from './event-resize'
import { Emitter } from '../common/Emitter'
import { processScopedUiProps, EventUiHash, EventUi } from '../component/event-ui'
import { EventDefHash } from '../structs/event-def'
import { parseToolbars } from '../toolbar-parse'
import { firstDefined } from '../util/misc'
import { globalDefaults, mergeOptions } from '../options'
import { rangeContainsMarker } from '../datelib/date-range'
import { ViewApi } from '../ViewApi'
import { parseBusinessHours } from '../structs/business-hours'
import { globalPlugins } from '../global-plugins'
import { createEmptyEventStore } from '../structs/event-store'
import { CalendarContext } from '../CalendarContext'
import { buildComputedOptions } from '../ComputedOptions'
import { CalendarDataManagerState, CalendarOptionsData, CalendarCurrentViewData, CalendarData } from './data-types'
import { __assign } from 'tslib'
import { TaskRunner } from '../util/runner'
import { buildTitle } from './title-formatting'


export interface CalendarDataManagerProps {
  optionOverrides: any
  calendarApi: CalendarApi
  onAction?: (action: Action) => void
  onData?: (data: CalendarData) => void
}

export type ReducerFunc = ( // TODO: rename to CalendarDataInjector. move view-props-manip hook here as well?
  currentState: object | null,
  action: Action | null,
  context: CalendarContext & CalendarDataManagerState // more than just context
) => object


// in future refactor, do the redux-style function(state=initial) for initial-state
// also, whatever is happening in constructor, have it happen in action queue too


export class CalendarDataManager {

  private computeOptionsData = memoize(this._computeOptionsData)
  private computeCurrentViewData = memoize(this._computeCurrentViewData)
  private organizeRawLocales = memoize(organizeRawLocales)
  private buildCalendarOptions = memoize(mergeOptionSets)
  private buildComputedCalendarOptions = memoize(buildComputedOptions)
  private buildLocale = memoize(buildLocale)
  private buildPluginHooks = memoize(buildPluginHooks)
  private buildDateEnv = memoize(buildDateEnv)
  private buildTheme = memoize(buildTheme)
  private parseToolbars = memoize(parseToolbars)
  private buildViewSpecs = memoize(buildViewSpecs)
  private buildViewOptions = memoize(mergeOptionSets)
  private buildComputedViewOptions = memoize(buildComputedOptions)
  private buildDateProfileGenerator = memoizeObjArg(buildDateProfileGenerator)
  private buildViewApi = memoize(buildViewApi)
  private buildViewUiProps = memoizeObjArg(buildViewUiProps)
  private buildEventUiBySource = memoize(buildEventUiBySource, isPropsEqual)
  private buildEventUiBases = memoize(buildEventUiBases)
  private parseContextBusinessHours = memoizeObjArg(parseContextBusinessHours)
  private buildTitle = memoize(buildTitle)

  public emitter = new Emitter()
  private actionRunner = new TaskRunner(this._handleAction.bind(this), this.updateData.bind(this))
  private props: CalendarDataManagerProps
  private state: CalendarDataManagerState
  private data: CalendarData


  constructor(props: CalendarDataManagerProps) {
    this.props = props
    this.actionRunner.pause()

    let dynamicOptionOverrides = {}
    let optionsData = this.computeOptionsData(
      props.optionOverrides,
      dynamicOptionOverrides,
      props.calendarApi
    )

    let currentViewType = optionsData.calendarOptions.initialView || optionsData.pluginHooks.initialView
    let currentViewData = this.computeCurrentViewData(
      optionsData,
      currentViewType,
      props.optionOverrides,
      dynamicOptionOverrides
    )

    // wire things up
    // TODO: not DRY
    props.calendarApi.currentDataManager = this
    this.emitter.setThisContext(props.calendarApi)
    this.emitter.setOptions(currentViewData.options)

    let currentDate = getInitialDate(optionsData.calendarOptions, optionsData.dateEnv)
    let dateProfile = currentViewData.dateProfileGenerator.build(currentDate)

    if (!rangeContainsMarker(dateProfile.activeRange, currentDate)) {
      currentDate = dateProfile.currentRange.start
    }

    let calendarContext: CalendarContext = {
      dateEnv: optionsData.dateEnv,
      options: optionsData.calendarOptions,
      computedOptions: optionsData.computedCalendarOptions,
      pluginHooks: optionsData.pluginHooks,
      calendarApi: props.calendarApi,
      dispatch: this.dispatch,
      emitter: this.emitter,
      getCurrentData: this.getCurrentData
    }

    // NOT DRY
    let eventSources = initEventSources(optionsData.calendarOptions, dateProfile, calendarContext)

    let initialState: CalendarDataManagerState = {
      dynamicOptionOverrides,
      currentViewType,
      currentDate,
      dateProfile,
      businessHours: this.parseContextBusinessHours(calendarContext), // weird to have this in state
      eventSources,
      eventUiBases: {},
      loadingLevel: computeEventSourceLoadingLevel(eventSources),
      eventStore: createEmptyEventStore(),
      renderableEventStore: createEmptyEventStore(),
      dateSelection: null,
      eventSelection: '',
      eventDrag: null,
      eventResize: null,
      selectionConfig: this.buildViewUiProps(calendarContext).selectionConfig
    }
    let contextAndState = { ...calendarContext, ...initialState }

    for (let reducer of optionsData.pluginHooks.reducers) {
      __assign(initialState, reducer(null, null, contextAndState))
    }

    if (initialState.loadingLevel) {
      this.emitter.trigger('loading', true) // NOT DRY
    }

    this.state = initialState
    this.updateData()
    this.actionRunner.resume()
  }


  getCurrentData = () => {
    return this.data
  }


  dispatch = (action: Action) => {
    this.actionRunner.request(action) // protects against recursive calls to _handleAction
  }


  resetOptions(optionOverrides, append?: boolean) {
    let { props } = this

    props.optionOverrides = append
      ? { ...props.optionOverrides, ...optionOverrides }
      : optionOverrides

    this.actionRunner.pause('resetOptions')
    this.updateData()
    this.actionRunner.resume('resetOptions')
  }


  _handleAction(action: Action) {
    let { props, state, emitter } = this

    let dynamicOptionOverrides = reduceDynamicOptionOverrides(state.dynamicOptionOverrides, action)
    let optionsData = this.computeOptionsData(
      props.optionOverrides,
      dynamicOptionOverrides,
      props.calendarApi
    )

    let currentViewType = reduceViewType(state.currentViewType, action)
    let currentViewData = this.computeCurrentViewData(
      optionsData,
      currentViewType,
      props.optionOverrides,
      dynamicOptionOverrides
    )

    // wire things up
    // TODO: not DRY
    props.calendarApi.currentDataManager = this
    emitter.setThisContext(props.calendarApi)
    emitter.setOptions(currentViewData.options)

    let calendarContext: CalendarContext = {
      dateEnv: optionsData.dateEnv,
      options: optionsData.calendarOptions,
      computedOptions: optionsData.computedCalendarOptions,
      pluginHooks: optionsData.pluginHooks,
      calendarApi: props.calendarApi,
      dispatch: this.dispatch,
      emitter,
      getCurrentData: this.getCurrentData
    }

    let currentDate = state.currentDate
    let dateProfile = state.dateProfile

    if (this.data && this.data.dateProfileGenerator !== currentViewData.dateProfileGenerator) { // hack
      dateProfile = currentViewData.dateProfileGenerator.build(currentDate)
    }

    currentDate = reduceCurrentDate(currentDate, action)
    dateProfile = reduceDateProfile(dateProfile, action, currentDate, currentViewData.dateProfileGenerator)

    if (!rangeContainsMarker(dateProfile.currentRange, currentDate)) {
      currentDate = dateProfile.currentRange.start
    }

    let eventSources = reduceEventSources(state.eventSources, action, dateProfile, calendarContext)
    let eventSourceLoadingLevel = computeEventSourceLoadingLevel(eventSources)
    let eventStore = reduceEventStore(state.eventStore, action, eventSources, dateProfile, calendarContext)

    let renderableEventStore =
      (eventSourceLoadingLevel && !currentViewData.options.progressiveEventRendering) ?
        (state.renderableEventStore || eventStore) : // try from previous state
        eventStore

    let { eventUiSingleBase, selectionConfig } = this.buildViewUiProps(calendarContext) // will memoize obj
    let eventUiBySource = this.buildEventUiBySource(eventSources)
    let eventUiBases = this.buildEventUiBases(renderableEventStore.defs, eventUiSingleBase, eventUiBySource)

    let prevLoadingLevel = state.loadingLevel || 0
    let loadingLevel = eventSourceLoadingLevel

    let newState: CalendarDataManagerState = {
      dynamicOptionOverrides,
      currentViewType,
      currentDate,
      dateProfile,
      eventSources,
      eventStore,
      renderableEventStore,
      selectionConfig,
      eventUiBases,
      loadingLevel,
      businessHours: this.parseContextBusinessHours(calendarContext), // will memoize obj
      dateSelection: reduceDateSelection(state.dateSelection, action),
      eventSelection: reduceSelectedEvent(state.eventSelection, action),
      eventDrag: reduceEventDrag(state.eventDrag, action),
      eventResize: reduceEventResize(state.eventResize, action)
    }
    let contextAndState = { ...calendarContext, ...newState }

    for (let reducer of optionsData.pluginHooks.reducers) {
      __assign(newState, reducer(state, action, contextAndState)) // give the OLD state, for old value
    }

    if (!prevLoadingLevel && loadingLevel) {
      emitter.trigger('loading', true)
    } else if (prevLoadingLevel && !loadingLevel) {
      emitter.trigger('loading', false)
    }

    this.state = newState

    if (props.onAction) {
      props.onAction(action)
    }
  }


  updateData() {
    let { props, state } = this
    let oldData = this.data

    let optionsData = this.computeOptionsData(
      props.optionOverrides,
      state.dynamicOptionOverrides,
      props.calendarApi
    )

    let currentViewData = this.computeCurrentViewData(
      optionsData,
      state.currentViewType,
      props.optionOverrides,
      state.dynamicOptionOverrides
    )

    let data: CalendarData = this.data = {
      viewTitle: this.buildTitle(state.dateProfile, currentViewData.options, optionsData.dateEnv),
      calendarApi: props.calendarApi,
      dispatch: this.dispatch,
      emitter: this.emitter,
      getCurrentData: this.getCurrentData,
      ...optionsData,
      ...currentViewData,
      ...state
    }

    let changeHandlers = optionsData.pluginHooks.optionChangeHandlers
    let oldCalendarOptions = oldData && oldData.calendarOptions
    let newCalendarOptions = optionsData.calendarOptions

    if (oldCalendarOptions && oldCalendarOptions !== newCalendarOptions) {

      if (oldCalendarOptions.timeZone !== newCalendarOptions.timeZone) {
        data.eventSources = reduceEventSourcesNewTimeZone(data.eventSources, state.dateProfile, data)
        data.eventStore = rezoneEventStoreDates(data.eventStore, oldData.dateEnv, data.dateEnv)
      }

      for (let optionName in changeHandlers) {
        if (oldCalendarOptions[optionName] !== newCalendarOptions[optionName]) {
          changeHandlers[optionName](newCalendarOptions[optionName], data)
        }
      }
    }

    if (props.onData) {
      props.onData(data)
    }
  }


  _computeOptionsData(optionOverrides, dynamicOptionOverrides, calendarApi: CalendarApi): CalendarOptionsData {
    // TODO: blacklist options that are handled by optionChangeHandlers

    let locales = firstDefined( // explicit locale option given?
      dynamicOptionOverrides.locales,
      optionOverrides.locales,
      globalDefaults.locales
    )
    let locale = firstDefined( // explicit locales option given?
      dynamicOptionOverrides.locale,
      optionOverrides.locale,
      globalDefaults.locale
    )

    let availableLocaleData = this.organizeRawLocales(locales)
    let availableRawLocales = availableLocaleData.map
    let localeDefaults = this.buildLocale(locale || availableLocaleData.defaultCode, availableRawLocales).options
    let calendarOptions = this.buildCalendarOptions( // NOTE: use viewOptions mostly instead
      globalDefaults,
      localeDefaults,
      optionOverrides,
      dynamicOptionOverrides
    )

    let pluginHooks = this.buildPluginHooks(calendarOptions.plugins, globalPlugins)
    let dateEnv = this.buildDateEnv(
      calendarOptions.timeZone,
      calendarOptions.locale,
      calendarOptions.weekNumberCalculation,
      calendarOptions.firstDay,
      calendarOptions.weekText,
      pluginHooks,
      availableLocaleData
    )

    let viewSpecs = this.buildViewSpecs(pluginHooks.views, optionOverrides, dynamicOptionOverrides, localeDefaults)
    let theme = this.buildTheme(calendarOptions, pluginHooks)
    let toolbarConfig = this.parseToolbars(calendarOptions, optionOverrides, theme, viewSpecs, calendarApi)
    let computedCalendarOptions = this.buildComputedCalendarOptions(calendarOptions)

    return {
      calendarOptions,
      computedCalendarOptions,
      availableRawLocales,
      pluginHooks,
      dateEnv,
      viewSpecs,
      theme,
      toolbarConfig,
      localeDefaults
    }
  }


  _computeCurrentViewData(optionsData: CalendarOptionsData, currentViewType: string, optionOverrides, dynamicOptionOverrides): CalendarCurrentViewData {
    let viewSpec = optionsData.viewSpecs[currentViewType]

    if (!viewSpec) {
      throw new Error(`viewType "${currentViewType}" is not available. Please make sure you've loaded all neccessary plugins`)
    }

    let options = this.buildViewOptions( // merge defaults and overrides. lowest to highest precedence
      globalDefaults,
      viewSpec.optionDefaults,
      optionsData.localeDefaults,
      optionOverrides,
      viewSpec.optionOverrides,
      dynamicOptionOverrides
    )

    let computedOptions = this.buildComputedViewOptions(options)

    let dateProfileGenerator = this.buildDateProfileGenerator({
      viewSpec,
      dateEnv: optionsData.dateEnv,
      slotMinTime: options.slotMinTime,
      slotMaxTime: options.slotMaxTime,
      showNonCurrentDates: options.showNonCurrentDates,
      dayCount: options.dayCount,
      dateAlignment: options.dateAlignment,
      dateIncrement: options.dateIncrement,
      hiddenDays: options.hiddenDays,
      weekends: options.weekends,
      now: options.now,
      validRange: options.validRange,
      visibleRange: options.visibleRange,
      monthMode: options.monthMode,
      fixedWeekCount: options.fixedWeekCount
    })

    let viewApi = this.buildViewApi(currentViewType, this.getCurrentData, optionsData.dateEnv)

    return { viewSpec, options, computedOptions, dateProfileGenerator, viewApi }
  }

}


function mergeOptionSets(...optionSets: any[]) {
  return mergeOptions(optionSets)
}


function buildDateEnv(
  timeZone: string,
  explicitLocale: string,
  weekNumberCalculation,
  firstDay,
  weekText,
  pluginHooks: PluginHooks,
  availableLocaleData: RawLocaleInfo
) {
  let locale = buildLocale(explicitLocale || availableLocaleData.defaultCode, availableLocaleData.map)

  return new DateEnv({
    calendarSystem: 'gregory', // TODO: make this a setting
    timeZone: timeZone,
    namedTimeZoneImpl: pluginHooks.namedTimeZonedImpl,
    locale,
    weekNumberCalculation,
    firstDay,
    weekText,
    cmdFormatter: pluginHooks.cmdFormatter
  })
}


function buildTheme(optionOverrides, pluginHooks: PluginHooks) {
  let ThemeClass = pluginHooks.themeClasses[optionOverrides.themeSystem] || StandardTheme

  return new ThemeClass(optionOverrides)
}


function buildDateProfileGenerator(props: DateProfileGeneratorProps): DateProfileGenerator {
  let DateProfileGeneratorClass = props.viewSpec.optionDefaults.dateProfileGeneratorClass || DateProfileGenerator

  return new DateProfileGeneratorClass(props)
}


function buildViewApi(type: string, getCurrentData: () => CalendarData, dateEnv: DateEnv) {
  return new ViewApi(type, getCurrentData, dateEnv)
}


function buildEventUiBySource(eventSources: EventSourceHash): EventUiHash {
  return mapHash(eventSources, function(eventSource) {
    return eventSource.ui
  })
}


function buildEventUiBases(eventDefs: EventDefHash, eventUiSingleBase: EventUi, eventUiBySource: EventUiHash) {
  let eventUiBases: EventUiHash = { '': eventUiSingleBase }

  for (let defId in eventDefs) {
    let def = eventDefs[defId]

    if (def.sourceId && eventUiBySource[def.sourceId]) {
      eventUiBases[defId] = eventUiBySource[def.sourceId]
    }
  }

  return eventUiBases
}


function buildViewUiProps(calendarContext: CalendarContext) {
  return {
    eventUiSingleBase: processScopedUiProps('event', calendarContext.options, calendarContext),
    selectionConfig: processScopedUiProps('select', calendarContext.options, calendarContext)
  }
}


function parseContextBusinessHours(calendarContext: CalendarContext) {
  return parseBusinessHours(calendarContext.options.businessHours, calendarContext)
}
