<template>
  <div class="page-section-skeleton" aria-hidden="true">
    <div v-for="section in 3" :key="section" class="skeleton-section">
      <n-skeleton text :width="section === 2 ? '132px' : '168px'" height="26px" round />
      <div class="skeleton-lines">
        <n-skeleton v-for="line in 4" :key="line" text height="18px" round />
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.page-section-skeleton {
  width: 100%;
  padding-top: 14px;
}

.skeleton-section + .skeleton-section {
  margin-top: 32px;
}

.skeleton-lines {
  display: grid;
  gap: 14px;
  margin-top: 22px;
  padding: 0 4px;
}
</style>
