# Scikit-Learn

> **Why a quant must own this:** scikit-learn is the workhorse for classical ML
> in research — regularized regression for factor models, tree ensembles for
> return prediction, PCA for risk factors, standardization pipelines. Its
> consistent `fit`/`predict`/`transform` API and `Pipeline`/cross-validation
> machinery are exactly what you need to avoid the cardinal sins of quant ML:
> **data leakage** and **lookahead in cross-validation**. Interviewers care less
> about which model you pick and more about whether you can validate it honestly
> on time-series data.

## First principles: the estimator API

Every scikit-learn object follows one of two interfaces, which is why the library
composes so cleanly:

- **Estimator/predictor:** `.fit(X, y)` learns parameters; `.predict(X)` (or
  `.predict_proba`) produces outputs.
- **Transformer:** `.fit(X)` learns a transform; `.transform(X)` applies it;
  `.fit_transform` does both.

`X` is a 2-D array/DataFrame of shape `(n_samples, n_features)`; `y` is the
target. Keeping that shape convention straight is half the battle.

```python
import numpy as np
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler

X = features.to_numpy()          # (n_days, n_factors)
y = fwd_returns.to_numpy()       # (n_days,) -- next-period return (already lagged!)

model = Ridge(alpha=1.0)         # L2-regularized linear regression
model.fit(X, y)
preds = model.predict(X)
print(model.coef_)               # factor loadings (betas)
```

## The leakage trap, and why Pipelines fix it

The most common — and most dangerous — mistake is **fitting a preprocessing step
on the whole dataset before splitting.** Standardizing with the *full-sample*
mean/std leaks information from the test set (and the future) into training.

```python
# WRONG: scaler sees the test/future data -> leakage, inflated scores
X_scaled = StandardScaler().fit_transform(X)     # fit on EVERYTHING
# ...then split and train on X_scaled
```

A `Pipeline` binds preprocessing to the model so that, during cross-validation,
the scaler is `fit` **only on each training fold** and merely `transform`-ed on
the validation fold — no leakage.

```python
from sklearn.pipeline import make_pipeline
from sklearn.model_selection import cross_val_score, TimeSeriesSplit

pipe = make_pipeline(StandardScaler(), Ridge(alpha=1.0))
cv = TimeSeriesSplit(n_splits=5)                  # see below -- respects time order
scores = cross_val_score(pipe, X, y, cv=cv, scoring="r2")
```

> **The rule:** any statistic learned from data (means, std, PCA components,
> feature selection, target encoding) must be fit on training data *inside* the
> CV loop. `Pipeline` is the mechanism that guarantees it. Hand-rolled
> preprocessing outside CV is how backtests lie.

## Cross-validation for time series

Standard k-fold CV **shuffles** rows — catastrophic for time series, because it
trains on the future to predict the past (lookahead). Use **`TimeSeriesSplit`**,
which only ever trains on data *before* the validation window.

```text
   TimeSeriesSplit (n_splits=4):
   fold 1: train[░░         ] valid[▓        ]
   fold 2: train[░░░░       ] valid[  ▓      ]
   fold 3: train[░░░░░░     ] valid[    ▓    ]
   fold 4: train[░░░░░░░░   ] valid[      ▓  ]
                  past ──────────────▶ future   (train is ALWAYS before valid)
```

For overlapping labels (e.g. multi-day forward returns) even this leaks at the
boundary; López de Prado's **purged / embargoed CV** removes samples near the
split. Plain `KFold`/`train_test_split(shuffle=True)` on financial time series is
a red flag in any review.

## Models you'll actually reach for

| Task                          | Estimator                                   | Why                                  |
|-------------------------------|---------------------------------------------|--------------------------------------|
| Linear factor model           | `Ridge`, `Lasso`, `ElasticNet`              | regularization tames collinear factors|
| Classification (up/down)      | `LogisticRegression`                        | calibrated probabilities             |
| Nonlinear return prediction   | `RandomForestRegressor`, `GradientBoosting` | handle interactions; (often XGBoost/LightGBM in practice)|
| Risk factors / dimensionality | `PCA`, `TruncatedSVD`                       | orthogonal factors from returns      |
| Clustering regimes            | `KMeans`, `GaussianMixture`                 | regime detection                     |

```python
from sklearn.decomposition import PCA
pca = PCA(n_components=5).fit(returns_matrix)     # principal risk factors
factors = pca.transform(returns_matrix)           # exposures over time
print(pca.explained_variance_ratio_)              # how much variance each captures
```

## Hyperparameters: search them honestly

```python
from sklearn.model_selection import GridSearchCV
grid = GridSearchCV(
    make_pipeline(StandardScaler(), Ridge()),
    param_grid={"ridge__alpha": [0.1, 1.0, 10.0]},
    cv=TimeSeriesSplit(5), scoring="neg_mean_squared_error",
)
grid.fit(X, y)                                     # CV done with time-aware folds
print(grid.best_params_)
```

The double-underscore (`ridge__alpha`) addresses a step inside the pipeline. The
search runs *inside* time-aware CV, so the chosen `alpha` isn't fit to the
future.

## Performance reality

- scikit-learn delegates heavy math to **NumPy/SciPy → BLAS/LAPACK** and Cython,
  and many estimators support `n_jobs=-1` for joblib-based parallelism (across
  CV folds, trees, etc.). It is **CPU/in-memory** — for data larger than RAM,
  use incremental estimators (`partial_fit`), `HistGradientBoosting`, or move to
  Dask/Spark.
- **Tree ensembles dominate runtime** in practice; for serious gradient boosting,
  XGBoost/LightGBM are faster and usually more accurate than sklearn's, with the
  same API shape.
- **`float32`** halves memory and speeds large fits at a small precision cost —
  often fine for ML features (cf. the dtype lesson).
- Beware `n_jobs` × BLAS-thread **oversubscription** (the multiprocessing-lesson
  trap): set BLAS threads to 1 in workers.

## Quant relevance & interview gotchas

- **Data leakage** is the #1 quant-ML interview topic. Sources: scaling/feature
  selection/PCA fit on the full sample; using a label that incorporates future
  data; merging a future-dated value (cf. `merge_asof`). `Pipeline` + time-aware
  CV is the antidote.
- **Shuffled CV on time series** trains on the future — never use plain
  `KFold`/`train_test_split(shuffle=True)` for sequential financial data.
- **Overlapping labels** (forward-return windows) require purged/embargoed CV;
  naive `TimeSeriesSplit` still leaks at the boundary.
- **Non-stationarity / regime change:** a model fit on one regime fails in the
  next; financial signal-to-noise is tiny, so an R² of 0.01 can be economically
  meaningful and an R² of 0.5 is almost certainly leakage. Be suspicious of
  great scores.
- **Standardize using only past data** for live signals — a rolling/expanding
  scaler, not a full-sample one.
- **Reproducibility:** set `random_state` on every estimator with randomness
  (trees, KMeans, splits) or results won't replicate.

## Key takeaways

1. The uniform `fit`/`predict`/`transform` API is what makes scikit-learn
   composable; `X` is `(n_samples, n_features)`.
2. Fit any data-derived transform **inside** the CV loop — `Pipeline` enforces it
   and prevents leakage.
3. Use `TimeSeriesSplit` (or purged/embargoed CV) for financial time series;
   shuffled k-fold leaks the future.
4. Regularized linear models tame collinear factors; PCA extracts risk factors;
   tree ensembles capture nonlinearity (XGBoost/LightGBM in practice).
5. Tune hyperparameters via `GridSearchCV`/`RandomizedSearchCV` *inside*
   time-aware CV; address pipeline steps with `step__param`.
6. Suspiciously high scores usually mean leakage; set `random_state` for
   reproducibility; standardize on past-only data live.

## Self-check

1. Why does `StandardScaler().fit_transform(X)` on the full dataset before CV
   cause leakage, and how does a `Pipeline` prevent it?
2. Why is shuffled k-fold cross-validation wrong for a price-based time series,
   and what do you use instead?
3. You get an out-of-sample R² of 0.6 on next-day return prediction. What's your
   first hypothesis, and how do you check it?
4. What does the `ridge__alpha` syntax mean in a `GridSearchCV` `param_grid`?
5. When do overlapping forward-return labels still leak under `TimeSeriesSplit`,
   and what fixes it?
6. How should feature standardization differ between a research backtest and a
   live signal?

## Further reading

- [scikit-learn User Guide](https://scikit-learn.org/stable/user_guide.html) and [Pipelines & composite estimators](https://scikit-learn.org/stable/modules/compose.html).
- [Cross-validation](https://scikit-learn.org/stable/modules/cross_validation.html) and [`TimeSeriesSplit`](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html).
- [Common pitfalls and recommended practices](https://scikit-learn.org/stable/common_pitfalls.html) (data leakage).
- [Preprocessing data](https://scikit-learn.org/stable/modules/preprocessing.html) and [Decomposition / PCA](https://scikit-learn.org/stable/modules/decomposition.html).
- Marcos López de Prado, *Advances in Financial Machine Learning*, Ch. 7 (cross-validation in finance — purging & embargo).

## Videos

- Andreas Müller — **"Machine Learning with scikit-learn"** tutorials (SciPy/PyData) ([search](https://www.youtube.com/results?search_query=Andreas+Muller+scikit-learn+tutorial+SciPy)).
- PyData — **"Avoiding data leakage in machine learning"** ([search](https://www.youtube.com/results?search_query=PyData+data+leakage+machine+learning)).
