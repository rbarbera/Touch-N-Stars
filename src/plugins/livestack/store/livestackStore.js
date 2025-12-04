import { defineStore } from 'pinia';
import apiService from '@/services/apiService';
import { useSettingsStore } from '@/store/settingsStore';

export const useLivestackStore = defineStore('livestackStore', {
  state: () => ({
    availableImages: [],
    availableTargets: [],
    availableFilters: [],
    histogramSettings: [],
    selectedFilter: null,
    selectedTarget: null,
    currentImageTarget: null,
    currentImageFilter: null,
    currentImageUrl: null,
    lastImageUpdate: null,
    status: 'stopped',
  }),
  getters: {
    currentCounter: (state) => {
      console.log('Getting currentCounter for filter:', state.selectedFilter);
      return state.selectedFilter?.count ?? '--';
    },

    isTrackingStacks: () => {
      const settingsStore = useSettingsStore();
      return settingsStore.livestack?.isTrackingStacks ?? true;
    },

    showFilters: () => {
      const settingsStore = useSettingsStore();
      // Fall back to true if persisted settings were missing the livestack section
      return settingsStore.livestack?.showFilters ?? true;
    },

    activeImages() {
      return this.showFilters
        ? this.availableImages
        : this.availableImages.filter((img) => img.filter === 'RGB');
    },

    activeTargets() {
      const targetsMap = new Map();
      this.activeImages.forEach(({ target, count }) => {
        if (!targetsMap.has(target)) {
          targetsMap.set(target, { label: target, count });
        }
      });
      return Array.from(targetsMap.values()).toSorted((a, b) => a.label.localeCompare(b.label));
    },

    activeFilters() {
      if (!this.selectedTarget) return [];
      const filtersMap = new Map();
      this.activeImages
        .filter((img) => img.target === this.selectedTarget.label)
        .forEach(({ filter, count }) => {
          if (filter && !filtersMap.has(filter)) {
            filtersMap.set(filter, { label: filter, count });
          }
        });
      return Array.from(filtersMap.values()).toSorted((a, b) => a.label.localeCompare(b.label));
    },

    getHistogramSettings(state) {
      (targetLabel, filterLabel) => {
        return state.histogramSettings.find(
          (s) => s.target === targetLabel && s.filter === filterLabel
        );
      };
    },
  },
  actions: {
    setShowFilters(show) {
      const settingsStore = useSettingsStore();
      if (!settingsStore.livestack) {
        settingsStore.livestack = { showFilters: true, isTrackingStacks: true };
      }
      settingsStore.livestack.showFilters = show;
      // If filters are hidden, ensure selection stays valid (RGB-only branch)
      this.selectedFilter = this._defaultFilter();
    },

    setTrackingStacks(track) {
      const settingsStore = useSettingsStore();
      if (!settingsStore.livestack) {
        settingsStore.livestack = { showFilters: true, isTrackingStacks: true };
      }
      settingsStore.livestack.isTrackingStacks = track;
    },

    setHistogramSettings(targetLabel, filterLabel, blackPoint, whitePoint, midPoint) {
      let setting = this.histogramSettings.find(
        (s) => s.target === targetLabel && s.filter === filterLabel
      );
      if (!setting) {
        setting = {
          target: targetLabel,
          filter: filterLabel,
          blackPoint: blackPoint,
          whitePoint: whitePoint,
          midPoint: midPoint,
        };
        this.histogramSettings.push(setting);
      } else {
        setting.blackPoint = blackPoint;
        setting.whitePoint = whitePoint;
        setting.midPoint = midPoint;
      }
    },

    resetHistogramSettings(targetLabel, filterLabel) {
      const setting = this.getHistogramSettings(targetLabel, filterLabel);
      if (setting) {
        setting.blackPoint = 0;
        setting.whitePoint = 255;
        setting.midPoint = 127;
      }
    },

    selectTarget(targetLabel) {
      const found = this.availableTargets.find((t) => t.label === targetLabel);
      this.selectedTarget =
        found || (this.availableTargets.length ? this.availableTargets[0] : null);

      this.availableFilters = this._filtersForTarget(this.selectedTarget?.label);
      this.selectedFilter = this._defaultFilter();
    },

    selectFilter(filterLabel) {
      const found = this.availableFilters.find((f) => f.label === filterLabel);
      if (found) {
        this.selectedFilter = found;
      } else if (!this.selectedFilter) {
        this.selectedFilter = this._defaultFilter();
      }
    },

    // Update count for a specific target/filter from WebSocket event
    updateCountForTargetFilter(targetLabel, filterLabel, count) {
      // Find or create target
      let image = this.availableImages.find(
        (img) => img.target === targetLabel && img.filter === filterLabel
      );
      if (!image) {
        this.availableImages.push({ target: targetLabel, filter: filterLabel, count });
      } else {
        image.count = count;
      }

      this.makeAvailableTargets();
      this.makeAvailableFilters();

      if (this.isTrackingStacks) {
        const filterAllowed = this.showFilters || filterLabel === 'RGB';
        if (filterAllowed) {
          this.selectTarget(targetLabel);
          this.selectFilter(filterLabel);
        }
      }
    },

    setCurrentImageUrl(imageUrl, target = null, filter = null) {
      // Clean up previous image URL if it exists
      if (this.currentImageUrl) {
        URL.revokeObjectURL(this.currentImageUrl);
      }
      this.currentImageUrl = imageUrl;
      this.currentImageTarget = target;
      this.currentImageFilter = filter;
      this.lastImageUpdate = new Date().toISOString();
    },

    clearCurrentImageUrl() {
      if (this.currentImageUrl) {
        URL.revokeObjectURL(this.currentImageUrl);
      }
      this.currentImageUrl = null;
      this.currentImageTarget = null;
      this.currentImageFilter = null;
      this.lastImageUpdate = null;
    },
    shouldReloadImage(target, filter) {
      // Reload if no image cached or target/filter changed
      return (
        !this.currentImageUrl ||
        this.currentImageTarget !== target ||
        this.currentImageFilter !== filter
      );
    },
    forceReloadImage() {
      // Force reload even if cached - used for websocket updates
      return true;
    },
    toogleShowFilters() {
      this.setShowFilters(!this.showFilters);
    },

    // Check image availability and initialize store state
    async checkImageAvailability() {
      try {
        const counts = await this.loadAllTargetFilterCounts();
        this.makeAvailableImages(counts);
        if (this.selectedTarget && this.selectedFilter) {
          return true;
        }
      } catch (error) {
        console.error('Error checking image availability:', error);
        this.makeAvailableImages([]);
        return false;
      }
    },

    // Fetch all target/filter/count tuples up front
    async loadAllTargetFilterCounts() {
      const result = await apiService.livestackImageAvailable();
      if (!result.Success || !Array.isArray(result.Response)) {
        console.log('✗ API response not successful or Response not array');
        return [];
      }

      const pairs = Array.from(
        new Map(
          result.Response.map(({ Target, Filter }) => ({ target: Target, filter: Filter }))
            .filter(({ target, filter }) => target && filter)
            .map(({ target, filter }) => [`${target}|${filter}`, { target, filter }])
        ).values()
      );

      console.log(`Fetching counts for ${pairs.length} target/filter pairs`);
      const counts = await Promise.all(
        pairs.map(async ({ target, filter }) => {
          try {
            const info = await apiService.livestackImageInfo(target, filter);
            const count =
              info?.Success && info.Response
                ? info.Response.IsMonochrome
                  ? (info.Response.StackCount ?? '--')
                  : `${info.Response.RedStackCount} | ${info.Response.GreenStackCount} | ${info.Response.BlueStackCount}`
                : '--';
            return { target, filter, count };
          } catch (error) {
            console.error('Error fetching livestack image info:', error);
            return { target, filter, count: '--' };
          }
        })
      );

      return counts;
    },

    // Build availableImages from counts
    makeAvailableImages(counts = []) {
      const normalized = Array.isArray(counts)
        ? counts.filter((c) => c && c.target && c.filter)
        : [];
      this.availableImages = normalized;
      this.makeAvailableTargets();
      this.makeAvailableFilters();
    },

    makeAvailableTargets() {
      const targetsMap = new Map();
      this.activeImages.forEach(({ target, count }) => {
        if (!targetsMap.has(target)) {
          targetsMap.set(target, { label: target, count });
        }
      });
      this.availableTargets = Array.from(targetsMap.values()).toSorted((a, b) =>
        a.label.localeCompare(b.label)
      );
      if (this.selectedTarget == null) {
        this.selectedTarget = this.availableTargets[0] || null;
      }
    },

    makeAvailableFilters() {
      this.availableFilters = this._filtersForTarget(this.selectedTarget?.label).toSorted((a, b) =>
        a.label.localeCompare(b.label)
      );
      this.selectedFilter = this._defaultFilter();
    },

    // Fetch info for a given target/filter using the API (authoritative count)
    async fetchAndUpdateCount(target, filter) {
      const targetLabel = target?.label ?? target;
      const filterLabel = filter?.label ?? filter;
      if (!targetLabel || !filterLabel) return;
      try {
        const info = await apiService.livestackImageInfo(targetLabel, filterLabel);
        if (info && info.Success && info.Response) {
          const count = info.Response.IsMonochrome
            ? (info.Response.StackCount ?? '--')
            : `${info.Response.RedStackCount} | ${info.Response.GreenStackCount} | ${info.Response.BlueStackCount}`;
          this.updateCountForTargetFilter(targetLabel, filterLabel, count);
        } else {
          console.log('livestackImageInfo returned no info for', targetLabel, filterLabel);
        }
      } catch (err) {
        console.error('Error fetching livestack image info:', err);
      }
    },

    // Collect filters for a given target from the current tuples
    _filtersForTarget(targetLabel) {
      if (!targetLabel) return [];

      const filtersMap = new Map();
      this.activeImages
        .filter((img) => img.target === targetLabel)
        .forEach(({ filter, count }) => {
          if (filter && !filtersMap.has(filter)) {
            filtersMap.set(filter, { label: filter, count });
          }
        });

      return Array.from(filtersMap.values());
    },
    _defaultFilter() {
      return (
        this.activeFilters.find((f) => f.label === this.selectedFilter?.label) ||
        this.availableFilters[0] ||
        null
      );
    },
  },
});
